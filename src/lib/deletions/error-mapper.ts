import type { ApiErrorCode } from "@/lib/http/api-response";

type DeletionResource = "campanha" | "lote";

type DatabaseErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

export type MappedDeletionError = {
  code: ApiErrorCode;
  message: string;
  status: number;
};

export function mapDeletionError(
  error: DatabaseErrorLike,
  resource: DeletionResource
): MappedDeletionError {
  const text = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const articleAndLabel = resource === "campanha" ? "A campanha" : "O lote";
  const errorToken = resource === "campanha" ? "campaign" : "batch";

  if (text.includes(`${errorToken}_not_found`) || error.code === "P0002") {
    return {
      code: "NOT_FOUND",
      message: `${articleAndLabel} não foi encontrado ou já foi excluído.`,
      status: 404
    };
  }

  if (text.includes(`${errorToken}_running`)) {
    return {
      code: "CONFLICT",
      message: `${articleAndLabel} possui um processamento em andamento. Finalize ou cancele o processamento antes de excluir.`,
      status: 409
    };
  }

  if (text.includes("delete_forbidden")) {
    return {
      code: "FORBIDDEN",
      message: "Você não possui permissão para executar esta exclusão.",
      status: 403
    };
  }

  if (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    text.includes("could not find the function") ||
    text.includes("does not exist")
  ) {
    return {
      code: "DATABASE_ERROR",
      message: "A rotina transacional de exclusão ainda não está instalada no banco. Aplique as migrations pendentes.",
      status: 503
    };
  }

  if (error.code === "23503") {
    return {
      code: "CONFLICT",
      message: `${articleAndLabel} não pôde ser excluído porque ainda existem vínculos de dados. Aplique a migration de correção e tente novamente.`,
      status: 409
    };
  }

  return {
    code: "DATABASE_ERROR",
    message: `${articleAndLabel} não pôde ser excluído. Consulte os logs do servidor para identificar o erro do banco.`,
    status: 500
  };
}
