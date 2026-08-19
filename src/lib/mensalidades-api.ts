import {
  analyzeMonthlyResponse,
  analyzeMonthlyResponses,
  MonthlyResponseError,
  type MonthlyAnalysis
} from "@/lib/analysis";
import { getProcessingConfig } from "@/lib/processing-config";

export type ErpErrorCode =
  | "ERP_TIMEOUT"
  | "ERP_NETWORK_ERROR"
  | "ERP_UNAUTHORIZED"
  | "ERP_RATE_LIMITED"
  | "ERP_SERVER_ERROR"
  | "ERP_HTTP_ERROR"
  | "ERP_INVALID_RESPONSE"
  | "ERP_NOT_CONFIGURED"
  | "PROCESSING_STOPPED";

export class ErpError extends Error {
  constructor(
    readonly code: ErpErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ErpError";
  }
}

export type MonthlyConsultationResult = {
  httpStatus: number;
  durationMs: number;
  analysis: MonthlyAnalysis;
};

export function buildMensalidadesRequestUrl(
  baseUrl: string,
  token: string,
  associatedCode: string,
  page = 1
) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("api/Mensalidades", normalizedBaseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("CodigoAssociadoEmpresa", associatedCode.trim());
  url.searchParams.set("HistoricoCompleto", "true");
  url.searchParams.set("limite", "200");
  url.searchParams.set("pagina", String(page));
  return url;
}

function readPaginationMetadata(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const dados = (input as { dados?: unknown }).dados;
  if (!dados || typeof dados !== "object") return null;

  const page = (dados as { CurrentPage?: unknown }).CurrentPage;
  const totalPages = (dados as { TotalPages?: unknown }).TotalPages;
  const totalCount = (dados as { TotalCount?: unknown }).TotalCount;
  const pageSize = (dados as { PageSize?: unknown }).PageSize;
  const data = (dados as { Data?: unknown }).Data;

  if (
    !Number.isInteger(page) ||
    !Number.isInteger(totalPages) ||
    !Number.isInteger(totalCount) ||
    !Number.isInteger(pageSize) ||
    !Array.isArray(data)
  ) {
    return null;
  }

  return {
    currentPage: page as number,
    totalPages: totalPages as number,
    totalCount: totalCount as number,
    pageSize: pageSize as number
  };
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const parsedDate = Date.parse(value);
  if (Number.isNaN(parsedDate)) return null;
  return Math.max(0, parsedDate - Date.now());
}

function errorForStatus(status: number, retryAfterMs?: number | null) {
  if (status === 401 || status === 403) {
    return new ErpError(
      "ERP_UNAUTHORIZED",
      "O ERP recusou a autenticação da consulta.",
      false,
      status
    );
  }
  if (status === 429) {
    return new ErpError(
      "ERP_RATE_LIMITED",
      "O ERP limitou temporariamente as consultas.",
      true,
      status,
      retryAfterMs ?? undefined
    );
  }
  if (status >= 500) {
    return new ErpError(
      "ERP_SERVER_ERROR",
      "O ERP apresentou uma falha interna.",
      true,
      status,
      retryAfterMs ?? undefined
    );
  }
  return new ErpError(
    "ERP_HTTP_ERROR",
    `O ERP respondeu com HTTP ${status}.`,
    false,
    status
  );
}

function errorFromAbort(
  controller: AbortController,
  externalSignal: AbortSignal | undefined,
  error: unknown
) {
  const reason = controller.signal.reason;

  if (externalSignal?.aborted || reason === "processing-stopped") {
    return new ErpError(
      "PROCESSING_STOPPED",
      "A consulta foi interrompida pelo operador.",
      false
    );
  }

  // AbortController.abort(reason) pode fazer o fetch rejeitar com o proprio
  // reason (inclusive uma string), em vez de um Error chamado AbortError.
  // Por isso o estado do signal e a fonte do abort sao a referencia canonica.
  if (
    controller.signal.aborted ||
    reason === "connect-timeout" ||
    reason === "read-timeout" ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new ErpError(
      "ERP_TIMEOUT",
      "A consulta ao ERP excedeu o tempo limite.",
      true
    );
  }

  return null;
}

function readErrorDiagnostic(error: unknown) {
  const direct = error instanceof Error ? error : null;
  const cause = direct?.cause;
  const causeRecord = cause && typeof cause === "object"
    ? cause as { name?: unknown; message?: unknown; code?: unknown }
    : null;

  return {
    errorName: direct?.name ?? typeof error,
    errorMessage: direct?.message ?? String(error),
    causeName: typeof causeRecord?.name === "string" ? causeRecord.name : null,
    causeMessage: typeof causeRecord?.message === "string" ? causeRecord.message : null,
    causeCode: typeof causeRecord?.code === "string" ? causeRecord.code : null
  };
}

function logNetworkFailure(baseUrl: string, page: number, error: unknown) {
  let host = "invalid-base-url";
  try {
    host = new URL(baseUrl).host;
  } catch {
    // Nunca registra token ou URL completa; somente o host quando valido.
  }

  console.error("[ERP_FETCH_NETWORK_FAILED]", {
    host,
    page,
    ...readErrorDiagnostic(error)
  });
}

async function readResponseBody(response: Response, controller: AbortController) {
  const { httpReadTimeoutMs } = await getProcessingConfig();
  const timeout = setTimeout(() => controller.abort("read-timeout"), httpReadTimeoutMs);
  try {
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function consultMonthlyByAssociatedCodeSinglePage(
  associatedCode: string,
  targetInstallmentId?: string,
  fallbackDueDate?: string,
  externalSignal?: AbortSignal
): Promise<MonthlyConsultationResult> {
  const baseUrl = process.env.MENSALIDADES_API_BASE_URL;
  const token = process.env.MENSALIDADES_API_TOKEN;
  if (!baseUrl || !token) {
    throw new ErpError(
      "ERP_NOT_CONFIGURED",
      "A API de mensalidades não está configurada no servidor.",
      false
    );
  }

  const url = buildMensalidadesRequestUrl(baseUrl, token, associatedCode);

  const { httpConnectTimeoutMs } = await getProcessingConfig();
  const controller = new AbortController();
  const abortFromWorker = () => controller.abort("processing-stopped");
  if (externalSignal?.aborted) controller.abort("processing-stopped");
  else externalSignal?.addEventListener("abort", abortFromWorker, { once: true });
  const startedAt = performance.now();
  const connectTimeout = setTimeout(() => controller.abort("connect-timeout"), httpConnectTimeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    clearTimeout(connectTimeout);

    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      throw errorForStatus(response.status, retryAfterMs);
    }

    const text = await readResponseBody(response, controller);
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new ErpError(
        "ERP_INVALID_RESPONSE",
        "O ERP retornou um corpo que não é JSON válido.",
        false,
        response.status
      );
    }

    try {
      return {
        httpStatus: response.status,
        durationMs: performance.now() - startedAt,
        analysis: analyzeMonthlyResponse(payload, targetInstallmentId, fallbackDueDate, {
          historyComplete: true
        })
      };
    } catch (error) {
      if (error instanceof MonthlyResponseError) {
        throw new ErpError(
          "ERP_INVALID_RESPONSE",
          error.message,
          false,
          response.status
        );
      }
      throw error;
    }
  } catch (error) {
    clearTimeout(connectTimeout);
    if (error instanceof ErpError) throw error;

    const abortError = errorFromAbort(controller, externalSignal, error);
    if (abortError) throw abortError;

    logNetworkFailure(baseUrl, 1, error);
    throw new ErpError(
      "ERP_NETWORK_ERROR",
      "Não foi possível estabelecer comunicação com o ERP.",
      true
    );
  } finally {
    externalSignal?.removeEventListener("abort", abortFromWorker);
  }
}

export async function consultMonthlyByAssociatedCode(
  associatedCode: string,
  targetInstallmentId?: string,
  fallbackDueDate?: string,
  externalSignal?: AbortSignal
): Promise<MonthlyConsultationResult> {
  const baseUrl = process.env.MENSALIDADES_API_BASE_URL;
  const token = process.env.MENSALIDADES_API_TOKEN;
  if (!baseUrl || !token) {
    throw new ErpError(
      "ERP_NOT_CONFIGURED",
      "A API de mensalidades nao esta configurada no servidor.",
      false
    );
  }

  const { httpConnectTimeoutMs, maxPagesPerOperation } = await getProcessingConfig();
  const controller = new AbortController();
  const abortFromWorker = () => controller.abort("processing-stopped");
  if (externalSignal?.aborted) controller.abort("processing-stopped");
  else externalSignal?.addEventListener("abort", abortFromWorker, { once: true });
  const startedAt = performance.now();
  const payloads: unknown[] = [];
  let requestedPage = 1;
  let expectedTotalPages: number | null = null;
  let httpStatus = 200;

  try {
    while (true) {
      if (requestedPage > maxPagesPerOperation) {
        throw new ErpError(
          "ERP_INVALID_RESPONSE",
          "A API de mensalidades excedeu o limite de paginas permitido.",
          false
        );
      }

      const url = buildMensalidadesRequestUrl(baseUrl, token, associatedCode, requestedPage);
      const connectTimeout = setTimeout(() => controller.abort("connect-timeout"), httpConnectTimeoutMs);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "application/json" },
          cache: "no-store"
        });
      } finally {
        clearTimeout(connectTimeout);
      }

      if (requestedPage === 1) httpStatus = response.status;

      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        throw errorForStatus(response.status, retryAfterMs);
      }

      const text = await readResponseBody(response, controller);
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new ErpError(
          "ERP_INVALID_RESPONSE",
          "O ERP retornou um corpo que nao e JSON valido.",
          false,
          response.status
        );
      }

      payloads.push(payload);
      const metadata = readPaginationMetadata(payload);
      if (!metadata) break;

      if (metadata.currentPage !== requestedPage) {
        throw new ErpError(
          "ERP_INVALID_RESPONSE",
          `A API retornou a pagina ${metadata.currentPage}, mas a pagina ${requestedPage} foi solicitada.`,
          false,
          response.status
        );
      }

      if (expectedTotalPages === null) {
        expectedTotalPages = metadata.totalPages;
      } else if (expectedTotalPages !== metadata.totalPages) {
        throw new ErpError(
          "ERP_INVALID_RESPONSE",
          "A API retornou uma quantidade de paginas inconsistente.",
          false,
          response.status
        );
      }

      if (metadata.totalPages === 0 || requestedPage >= metadata.totalPages) break;
      requestedPage += 1;
    }

    try {
      return {
        httpStatus,
        durationMs: performance.now() - startedAt,
        analysis: analyzeMonthlyResponses(payloads, targetInstallmentId, fallbackDueDate, {
          historyComplete: true
        })
      };
    } catch (error) {
      if (error instanceof MonthlyResponseError) {
        throw new ErpError("ERP_INVALID_RESPONSE", error.message, false, httpStatus);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ErpError) throw error;

    const abortError = errorFromAbort(controller, externalSignal, error);
    if (abortError) throw abortError;

    logNetworkFailure(baseUrl, requestedPage, error);
    throw new ErpError("ERP_NETWORK_ERROR", "Nao foi possivel estabelecer comunicacao com o ERP.", true);
  } finally {
    externalSignal?.removeEventListener("abort", abortFromWorker);
  }
}

export function __test__parseRetryAfterMs(value: string | null) {
  return parseRetryAfterMs(value);
}
