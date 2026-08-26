import { describe, expect, it } from "vitest";
import {
  analyzeMonthlyResponses,
  MonthlyResponseError
} from "@/lib/analysis";

function openItem(id: number) {
  return {
    Id: id,
    cod_usuario: "2448900",
    Valor: 10,
    ValorFinal: 10,
    ValorPago: null,
    DescricaoRecebimento: "ABERTO",
    DataVencimento: "10/08/2026"
  };
}

function paidItem(id: number) {
  return {
    Id: id,
    cod_usuario: "2448900",
    Valor: 30.67,
    ValorFinal: 31.43,
    ValorPago: 30.67,
    DescricaoRecebimento: "PIX ODONTOART - P4X",
    DescricaoPagamento: "CARTAO DE CRÉDITO ODONTOART - P4X EXTERNO",
    DataPagamento: "11/08/2026",
    DataVencimento: "10/08/2026"
  };
}

function page(input: {
  currentPage: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
  data: unknown[];
}) {
  return {
    codigo: 1,
    mensagem: "Consulta realizada com sucesso",
    dados: {
      RequestInfo: null,
      CurrentPage: input.currentPage,
      TotalPages: input.totalPages,
      TotalCount: input.totalCount,
      PageSize: input.pageSize,
      Data: input.data
    },
    erros: []
  };
}

describe("ERP pagination regression", () => {
  it("aceita PageSize menor na ultima pagina e encontra a parcela alvo paga", () => {
    const firstPageItems = Array.from({ length: 200 }, (_, index) => openItem(7000000 + index));
    const lastPageItems = [
      ...Array.from({ length: 23 }, (_, index) => openItem(7100000 + index)),
      paidItem(6618828)
    ];

    const result = analyzeMonthlyResponses(
      [
        page({
          currentPage: 1,
          totalPages: 2,
          totalCount: 224,
          pageSize: 200,
          data: firstPageItems
        }),
        page({
          currentPage: 2,
          totalPages: 2,
          totalCount: 224,
          pageSize: 24,
          data: lastPageItems
        })
      ],
      "6618828"
    );

    expect(result.paginationComplete).toBe(true);
    expect(result.currentPage).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.totalCount).toBe(224);
    expect(result.paymentStatus).toBe("paid");
    expect(result.paymentStatusSource).toBe("erp_explicit");
    expect(result.installments.find((item) => item.installmentCode === "6618828")).toMatchObject({
      paidAmountCents: 3067,
      baseAmountCents: 3067,
      paymentDescription: "PIX ODONTOART - P4X"
    });
  });

  it("continua rejeitando TotalPages divergente entre paginas", () => {
    expect(() => analyzeMonthlyResponses(
      [
        page({ currentPage: 1, totalPages: 2, totalCount: 2, pageSize: 1, data: [openItem(1)] }),
        page({ currentPage: 2, totalPages: 3, totalCount: 2, pageSize: 1, data: [paidItem(2)] })
      ],
      "2"
    )).toThrowError("As paginas do ERP possuem metadados incompativeis entre si.");
  });

  it("continua rejeitando TotalCount divergente entre paginas", () => {
    expect(() => analyzeMonthlyResponses(
      [
        page({ currentPage: 1, totalPages: 2, totalCount: 2, pageSize: 1, data: [openItem(1)] }),
        page({ currentPage: 2, totalPages: 2, totalCount: 3, pageSize: 1, data: [paidItem(2)] })
      ],
      "2"
    )).toThrowError("As paginas do ERP possuem metadados incompativeis entre si.");
  });

  it("continua rejeitando pagina duplicada", () => {
    expect(() => analyzeMonthlyResponses(
      [
        page({ currentPage: 1, totalPages: 2, totalCount: 2, pageSize: 1, data: [openItem(1)] }),
        page({ currentPage: 1, totalPages: 2, totalCount: 2, pageSize: 1, data: [paidItem(2)] })
      ],
      "2"
    )).toThrowError("As paginas do ERP estao duplicadas ou sem identificacao valida.");
  });

  it("mantem parcela realmente ausente como erro depois da paginacao completa", () => {
    expect(() => analyzeMonthlyResponses(
      [
        page({ currentPage: 1, totalPages: 2, totalCount: 2, pageSize: 1, data: [openItem(1)] }),
        page({ currentPage: 2, totalPages: 2, totalCount: 2, pageSize: 1, data: [openItem(2)] })
      ],
      "6592650"
    )).toThrowError(
      "A parcela alvo 6592650 nao foi localizada apos a consulta das paginas informadas pelo ERP."
    );
  });

  it("classifica pagamento parcial da parcela alvo como pago com pendencia", () => {
    const partialPaid = {
      ...paidItem(6582934),
      Valor: 33.26,
      ValorPago: 33.16
    };

    const result = analyzeMonthlyResponses(
      [page({ currentPage: 1, totalPages: 1, totalCount: 1, pageSize: 1, data: [partialPaid] })],
      "6582934"
    );

    expect(result.paymentStatus).toBe("paid");
    expect(result.paymentStatusSource).toBe("erp_explicit");
    expect(result.totalPaidAmountCents).toBe(3316);
    expect(result.totalPendingAmountCents).toBe(10);
    expect(result.installments.find((item) => item.installmentCode === "6582934")).toMatchObject({
      baseAmountCents: 3326,
      paidAmountCents: 3316,
      paymentDescription: "PIX ODONTOART - P4X"
    });
  });

  it("expoe erro tipado para respostas invalidas", () => {
    try {
      analyzeMonthlyResponses([], "6618828");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MonthlyResponseError);
    }
  });
});
