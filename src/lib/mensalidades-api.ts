import {
  analyzeMonthlyResponse,
  MonthlyResponseError,
  type MonthlyAnalysis
} from "@/lib/analysis";

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
    readonly httpStatus?: number
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

function configuredTimeoutMs() {
  const parsed = Number(process.env.MENSALIDADES_API_TIMEOUT_MS ?? "15000");
  if (!Number.isFinite(parsed) || parsed < 1000) return 15000;
  return Math.min(parsed, 60000);
}

function errorForStatus(status: number) {
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
      status
    );
  }
  if (status >= 500) {
    return new ErpError(
      "ERP_SERVER_ERROR",
      "O ERP apresentou uma falha interna.",
      true,
      status
    );
  }
  return new ErpError(
    "ERP_HTTP_ERROR",
    `O ERP respondeu com HTTP ${status}.`,
    false,
    status
  );
}

export async function consultMonthlyByCpf(
  cpf: string
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

  const url = new URL("/api/mensalidade/BuscarDadosMensalidades", baseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("CpfUsuario", cpf);

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), configuredTimeoutMs());

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store"
    });

    if (!response.ok) throw errorForStatus(response.status);

    const text = await response.text();
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
        durationMs: Date.now() - startedAt,
        analysis: analyzeMonthlyResponse(payload)
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
  } finally {
    clearTimeout(timeout);
  }
}
