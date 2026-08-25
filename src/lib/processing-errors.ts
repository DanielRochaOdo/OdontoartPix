export const INSTALLMENT_NOT_FOUND_LABEL = "Parcela não encontrada";

function normalizeErrorText(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

export function isMissingTargetInstallmentError(input: {
  processingStatus?: string | null;
  lastError?: string | null;
}) {
  if (String(input.processingStatus ?? "").trim().toLowerCase() !== "error") {
    return false;
  }

  const message = normalizeErrorText(input.lastError);
  return message.includes("parcela alvo") && message.includes("nao foi localizada");
}

export function memberProcessingStatusLabel(input: {
  processingStatus?: string | null;
  lastError?: string | null;
}) {
  return isMissingTargetInstallmentError(input)
    ? `Erro — ${INSTALLMENT_NOT_FOUND_LABEL}`
    : null;
}
