import { describe, expect, it } from "vitest";
import { analyzeMonthlyResponse, MonthlyResponseError } from "@/lib/analysis";

function paginatedPayload(item: Record<string, unknown>) {
  return {
    codigo: 1,
    mensagem: "Consulta realizada com sucesso",
    dados: {
      RequestInfo: null,
      CurrentPage: 1,
      TotalPages: 1,
      TotalCount: 1,
      PageSize: 1,
      Data: [item]
    },
    erros: []
  };
}

describe("pagamento parcial como verdade financeira terminal", () => {
  it("aceita o contrato real do ERP quando existe recebimento parcial", () => {
    const result = analyzeMonthlyResponse(
      paginatedPayload({
        Id: 6610709,
        DataVencimento: "11/08/2026",
        DataPagamento: "29/08/2026",
        NossoNumero: "06610709",
        Valor: 127.6,
        ValorImposto: 0,
        ValorAcrescimo: 0,
        ValorDesconto: 0,
        ValorTitulo: 127.6,
        ValorTaxa: 0,
        ValorAcrescimoAvulso: 0,
        ValorMultaJuros: 0,
        ValorDescontoAvulso: 0,
        ValorFinal: 131,
        ValorPago: 63.33,
        DescricaoParcela: "PLANO",
        DescricaoPagamento: "PIX - CLINICO",
        DescricaoRecebimento: "PIX ODONTOART - P4X"
      }),
      "6610709"
    );

    expect(result.paymentStatus).toBe("paid");
    expect(result.paymentStatusSource).toBe("erp_explicit");
    expect(result.targetFinancialState).toEqual({
      installmentCode: "6610709",
      paymentStatus: "paid",
      paymentStatusSource: "erp_explicit",
      installmentAmountCents: 12760,
      paymentAmountCents: 6333,
      pendingAmountCents: 6427
    });
    expect(result.installments[0]?.paidAmountCents).toBe(6333);
    expect(result.totalPaidAmountCents).toBe(6333);
    expect(result.totalPendingAmountCents).toBe(6427);
  });

  it("aceita ValorPago acima de Valor e limita o saldo residual a zero", () => {
    const result = analyzeMonthlyResponse(
      paginatedPayload({
        Id: "OVERPAID-1",
        Valor: "100,00",
        ValorPago: "105,00",
        ValorFinal: "105,00",
        DescricaoRecebimento: "PIX"
      }),
      "OVERPAID-1"
    );

    expect(result.paymentStatus).toBe("paid");
    expect(result.targetFinancialState.paymentAmountCents).toBe(10500);
    expect(result.targetFinancialState.pendingAmountCents).toBe(0);
  });

  it("mantem ABERTO como unpaid mesmo sem ValorPago", () => {
    const result = analyzeMonthlyResponse(
      paginatedPayload({
        Id: "OPEN-1",
        Valor: "50,00",
        ValorFinal: "50,00",
        DescricaoRecebimento: "ABERTO"
      }),
      "OPEN-1"
    );

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.targetFinancialState).toMatchObject({
      paymentStatus: "unpaid",
      installmentAmountCents: 5000,
      paymentAmountCents: 0,
      pendingAmountCents: 5000
    });
  });

  it("rejeita recebimento explicito sem ValorPago", () => {
    expect(() =>
      analyzeMonthlyResponse(
        paginatedPayload({
          Id: "MISSING-PAID",
          Valor: "50,00",
          ValorFinal: "50,00",
          DescricaoRecebimento: "PIX"
        }),
        "MISSING-PAID"
      )
    ).toThrowError(MonthlyResponseError);
  });

  it("rejeita Valor e ValorPago negativos em vez de normalizar silenciosamente", () => {
    expect(() =>
      analyzeMonthlyResponse(
        paginatedPayload({
          Id: "NEGATIVE-BASE",
          Valor: "-1,00",
          ValorPago: "1,00",
          DescricaoRecebimento: "PIX"
        }),
        "NEGATIVE-BASE"
      )
    ).toThrow(/Valor negativo/);

    expect(() =>
      analyzeMonthlyResponse(
        paginatedPayload({
          Id: "NEGATIVE-PAID",
          Valor: "1,00",
          ValorPago: "-1,00",
          DescricaoRecebimento: "PIX"
        }),
        "NEGATIVE-PAID"
      )
    ).toThrow(/ValorPago negativo/);
  });
});
