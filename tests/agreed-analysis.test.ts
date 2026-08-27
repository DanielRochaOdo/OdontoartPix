import { describe, expect, it } from "vitest";
import { analyzeMonthlyResponse, MonthlyResponseError } from "@/lib/analysis";

function payload(input: {
  description: string;
  amount: string;
  paidAmount?: string;
}) {
  return {
    codigo: 1,
    mensagem: "ok",
    dados: {
      RequestInfo: null,
      CurrentPage: 1,
      TotalPages: 1,
      TotalCount: 1,
      PageSize: 1,
      Data: [
        {
          Id: "1001",
          cod_usuario: "2001",
          Valor: input.amount,
          ValorFinal: input.amount,
          ...(input.paidAmount == null ? {} : { ValorPago: input.paidAmount }),
          DescricaoRecebimento: input.description,
          vencimento: "2026-08-15"
        }
      ]
    },
    erros: []
  };
}

describe("ACORDADO na analise financeira do ERP", () => {
  it("classifica ACORDADO como agreed sem valor pendente nem valor pago", () => {
    const result = analyzeMonthlyResponse(
      payload({ description: "ACORDADO", amount: "100,00", paidAmount: "25,00" }),
      "1001"
    );

    expect(result.paymentStatus).toBe("agreed");
    expect(result.paymentStatusSource).toBe("erp_agreed");
    expect(result.totalPendingAmountCents).toBe(0);
    expect(result.totalPaidAmountCents).toBe(0);
    expect(result.installments[0]?.paymentDescription).toBe("ACORDADO");
    expect(result.installments[0]?.baseAmountCents).toBe(10000);
    expect(result.installments[0]?.paidAmountCents).toBeNull();
  });

  it("mantem ABERTO como unpaid", () => {
    const result = analyzeMonthlyResponse(
      payload({ description: "ABERTO", amount: "100,00" }),
      "1001"
    );

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.totalPendingAmountCents).toBe(10000);
  });

  it("mantem recebimento comum como paid somente quando ValorPago cobre Valor", () => {
    const result = analyzeMonthlyResponse(
      payload({ description: "PIX", amount: "100,00", paidAmount: "100,00" }),
      "1001"
    );

    expect(result.paymentStatus).toBe("paid");
    expect(result.totalPaidAmountCents).toBe(10000);
  });

  it("trata recebimento comum com ValorPago inferior ao Valor como erro", () => {
    expect(() =>
      analyzeMonthlyResponse(
        payload({ description: "PIX", amount: "100,00", paidAmount: "99,99" }),
        "1001"
      )
    ).toThrowError(MonthlyResponseError);

    expect(() =>
      analyzeMonthlyResponse(
        payload({ description: "PIX", amount: "100,00", paidAmount: "99,99" }),
        "1001"
      )
    ).toThrow(/ValorPago inferior ao Valor/);
  });
});
