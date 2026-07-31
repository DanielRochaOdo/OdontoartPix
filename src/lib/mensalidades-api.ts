import {
  analyzeMonthlyResponse,
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
  | "ERP_NOT_CONFIGURED";

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

export function buildMensalidadesRequestUrl(baseUrl: string, token: string, associatedCode: string) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("api/Mensalidades", normalizedBaseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("CodigoAssociadoEmpresa", associatedCode.trim());
  return url;
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

async function readResponseBody(response: Response, controller: AbortController) {
  const { httpReadTimeoutMs } = await getProcessingConfig();
  const timeout = setTimeout(() => controller.abort("read-timeout"), httpReadTimeoutMs);
  try {
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function consultMonthlyByAssociatedCode(
  associatedCode: string,
  targetInstallmentId?: string
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
        analysis: analyzeMonthlyResponse(payload, targetInstallmentId)
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

    if (error instanceof Error && error.name === "AbortError") {
      throw new ErpError(
        "ERP_TIMEOUT",
        "A consulta ao ERP excedeu o tempo limite.",
        true
      );
    }

    throw new ErpError(
      "ERP_NETWORK_ERROR",
      "Não foi possível estabelecer comunicação com o ERP.",
      true
    );
  }
}

export function __test__parseRetryAfterMs(value: string | null) {
  return parseRetryAfterMs(value);
}
