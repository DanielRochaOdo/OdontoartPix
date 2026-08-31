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

describe("contrato financeiro da analise do ERP", () => {
  it("classifica ACORDADO como agreed sem valor pendente nem valor pago", () => {
    const result = analyzeMonthlyResponse(
      payload({ description: "ACORDADO", amount: "100,00", paidAmount: "25,00" }),
      "1001"
    );

    expect(result.paymentStatus).toBe("agreed");
    expect(result.paymentStatusSource).toBe("erp_agreed");
    expect(result.targetFinancialState).toEqual({
      installmentCode: "1001",
      paymentStatus: "agreed",
      paymentStatusSource: "erp_agreed",
      installmentAmountCents: 10000,
      paymentAmountCents: 0,
      pendingAmountCents: 0
    });
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
    expect(result.paymentStatusSource).toBe("erp_open_invoice");
    expect(result.targetFinancialState.pendingAmountCents).toBe(10000);
    expect(result.totalPendingAmountCents).toBe(10000);
  });

  it("classifica recebimento integral como paid", () => {
    const result = analyzeMonthlyResponse(
      payload({ description: "PIX", amount: "100,00", paidAmount: "100,00" }),
      "1001"
    );

    expect(result.paymentStatus).toBe("paid");
    expect(result.paymentStatusSource).toBe("erp_explicit");
    expect(result.targetFinancialState.pendingAmountCents).toBe(0);
    expect(result.totalPaidAmountCents).toBe(10000);
  });

  it("classifica recebimento parcial como paid e preserva o saldo residual", () => {
    const result = analyzeMonthlyResponse(
      payload({ description: "PIX", amount: "100,00", paidAmount: "99,99" }),
      "1001"
    );

    expect(result.paymentStatus).toBe("paid");
    expect(result.paymentStatusSource).toBe("erp_explicit");
    expect(result.targetFinancialState).toEqual({
      installmentCode: "1001",
      paymentStatus: "paid",
      paymentStatusSource: "erp_explicit",
      installmentAmountCents: 10000,
      paymentAmountCents: 9999,
      pendingAmountCents: 1
    });
    expect(result.totalPendingAmountCents).toBe(1);
    expect(result.totalPaidAmountCents).toBe(9999);
  });

  it("rejeita recebimento nao aberto com ValorPago zero por contradicao de contrato", () => {
    expect(() =>
      analyzeMonthlyResponse(
        payload({ description: "PIX", amount: "100,00", paidAmount: "0,00" }),
        "1001"
      )
    ).toThrowError(MonthlyResponseError);

    expect(() =>
      analyzeMonthlyResponse(
        payload({ description: "PIX", amount: "100,00", paidAmount: "0,00" }),
        "1001"
      )
    ).toThrow(/ValorPago e zero/);
  });
});
