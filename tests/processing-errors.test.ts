import { describe, expect, it } from "vitest";
import {
  INSTALLMENT_NOT_FOUND_LABEL,
  isMissingTargetInstallmentError,
  memberProcessingStatusLabel
} from "@/lib/processing-errors";

describe("processing errors", () => {
  it("identifica parcela alvo ausente como erro de parcela nao encontrada", () => {
    const input = {
      processingStatus: "error",
      lastError: "A parcela alvo 6612187 nao foi localizada apos a consulta das paginas informadas pelo ERP."
    };

    expect(isMissingTargetInstallmentError(input)).toBe(true);
    expect(memberProcessingStatusLabel(input)).toBe(`Erro — ${INSTALLMENT_NOT_FOUND_LABEL}`);
  });

  it("aceita a mensagem alternativa do historico completo", () => {
    expect(isMissingTargetInstallmentError({
      processingStatus: "error",
      lastError: "A parcela alvo 6583497 não foi localizada no histórico completo do ERP."
    })).toBe(true);
  });

  it("nao classifica outro erro do ERP como parcela nao encontrada", () => {
    expect(isMissingTargetInstallmentError({
      processingStatus: "error",
      lastError: "A parcela 6582934 possui DescricaoRecebimento diferente de ABERTO, mas ValorPago e menor que Valor."
    })).toBe(false);
  });

  it("nao permite a classificacao fora do status de erro", () => {
    expect(isMissingTargetInstallmentError({
      processingStatus: "processing",
      lastError: "A parcela alvo 6612187 nao foi localizada."
    })).toBe(false);
  });
});
