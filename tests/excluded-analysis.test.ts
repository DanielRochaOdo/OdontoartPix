import { describe, expect, it } from "vitest";
import { analyzeMonthlyResponse } from "@/lib/analysis";

function payload(input: {
  description: string;
  amount: string;
  paidAmount?: string;
  paymentDate?: string;
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
          ...(input.paymentDate == null ? {} : { DataPagamento: input.paymentDate }),
          vencimento: "2026-08-15"
        }
      ]
    },
    erros: []
  };
}

describe("DescricaoRecebimento EXCLUIDA", () => {
  it.each([
    ["sem ValorPago", undefined],
    ["com ValorPago zero", "0,00"],
    ["com ValorPago positivo residual do ERP", "100,00"]
  ])("classifica como excluded %s sem pagamento nem pendencia", (_label, paidAmount) => {
    const result = analyzeMonthlyResponse(
      payload({
        description: "EXCLUIDA",
        amount: "100,00",
        paidAmount,
        paymentDate: "04/09/2026"
      }),
      "1001"
    );

    expect(result.paymentStatus).toBe("excluded");
    expect(result.paymentStatusSource).toBe("erp_excluded");
    expect(result.targetFinancialState).toEqual({
      installmentCode: "1001",
      paymentStatus: "excluded",
      paymentStatusSource: "erp_excluded",
      installmentAmountCents: 10000,
      paymentAmountCents: 0,
      pendingAmountCents: 0
    });
    expect(result.totalPendingAmountCents).toBe(0);
    expect(result.totalPaidAmountCents).toBe(0);
    expect(result.installments[0]?.paymentDescription).toBe("EXCLUIDA");
    expect(result.installments[0]?.baseAmountCents).toBe(10000);
    expect(result.installments[0]?.paidAmountCents).toBeNull();
  });

  it("normaliza EXCLUIDA sem depender de caixa", () => {
    const result = analyzeMonthlyResponse(
      payload({ description: "excluida", amount: "75,00", paidAmount: "20,00" }),
      "1001"
    );

    expect(result.paymentStatus).toBe("excluded");
    expect(result.paymentStatusSource).toBe("erp_excluded");
    expect(result.targetFinancialState.paymentAmountCents).toBe(0);
    expect(result.targetFinancialState.pendingAmountCents).toBe(0);
  });
});
