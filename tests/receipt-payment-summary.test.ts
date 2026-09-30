import { describe, expect, it } from "vitest";
import {
  findReceiptPaymentMapping,
  isOpenReceiptPayment,
  RECEIPT_PAYMENT_MAPPING,
  RECEIPT_SUMMARY_ORDER
} from "@/lib/receipt-payment-summary";

describe("Resumo dos tipos de pagamento do Dashboard", () => {
  it("segue as 11 categorias do documento e exclui ABERTO da modal", () => {
    expect(RECEIPT_SUMMARY_ORDER).toEqual([
      "ACORDADO",
      "EXCLUIDA",
      "BOLETO CLÍNICO",
      "BOLETO ORTO",
      "CARTÃO ORTO",
      "CARTÃO CLÍNICO",
      "DINHEIRO",
      "ENEL",
      "PIX CLÍNICO",
      "PIX RECORRENTE",
      "PIX ORTO"
    ]);
    expect(RECEIPT_PAYMENT_MAPPING).toHaveLength(22);
    expect(RECEIPT_SUMMARY_ORDER.join("|")).not.toContain("ABERTO");
    expect(isOpenReceiptPayment("ABERTO")).toBe(true);
    expect(isOpenReceiptPayment("0 - ABERTO")).toBe(true);
  });

  it("agrupa as descrições específicas conforme o tipo resumido", () => {
    expect(findReceiptPaymentMapping("150 - BANCO DO BRASIL CLINICO")).toMatchObject({
      summary: "BOLETO CLÍNICO",
      systemLabel: "150 - BANCO DO BRASIL CLINICO"
    });
    expect(findReceiptPaymentMapping("CARTAO DE CREDITO - REDE - ORTO E PARTICULAR")?.summary).toBe("CARTÃO ORTO");
    expect(findReceiptPaymentMapping("DEBITO EM CONTA BB")?.summary).toBe("CARTÃO CLÍNICO");
    expect(findReceiptPaymentMapping("PIX - CLINICO")?.summary).toBe("PIX CLÍNICO");
    expect(findReceiptPaymentMapping("PIX RECORRENTE ODONTOART - P4X")?.summary).toBe("PIX RECORRENTE");
    expect(findReceiptPaymentMapping("172 - PIX NEW ODONTOLOGIA - P4X")?.summary).toBe("PIX ORTO");
  });

  it("tolera acentos, caixa e espaços sem fundir descrições diferentes", () => {
    expect(findReceiptPaymentMapping("cartão de crédito odontoart - p4x")?.summary).toBe("CARTÃO CLÍNICO");
    expect(findReceiptPaymentMapping("  159 - CARTAO DE CRÉDITO NEW ODONTO - P4X  ")?.summary).toBe("CARTÃO ORTO");
    expect(findReceiptPaymentMapping("PIX ODONTOART - P4X")?.summary).toBe("PIX CLÍNICO");
    expect(findReceiptPaymentMapping("PIX NEW ODONTO - P4X")?.summary).toBe("PIX ORTO");
  });
});
