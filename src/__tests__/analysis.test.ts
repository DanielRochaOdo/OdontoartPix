import { describe, expect, it } from "vitest";
import {
  analyzeMonthlyResponse,
  analyzeMonthlyResponses,
  MonthlyResponseError
} from "@/lib/analysis";

function page(input: {
  currentPage?: number;
  totalPages?: number;
  totalCount?: number;
  pageSize?: number;
  data?: unknown[];
  codigo?: number;
  erros?: unknown;
  mensagem?: string;
}) {
  return {
    codigo: input.codigo ?? 1,
    mensagem: input.mensagem,
    dados: {
      CurrentPage: input.currentPage ?? 1,
      TotalPages: input.totalPages ?? 1,
      TotalCount: input.totalCount ?? input.data?.length ?? 0,
      PageSize: input.pageSize ?? 100,
      Data: input.data ?? []
    },
    erros: input.erros ?? null
  };
}

describe("analyzeMonthlyResponse - contrato atual do ERP", () => {
  it("rejeita completamente o contrato legado de parcelas", () => {
    expect(() => analyzeMonthlyResponse({ parcelas: [] }, "55")).toThrow(
      "contrato paginado esperado"
    );
  });

  it("classifica ABERTO como unpaid", () => {
    const result = analyzeMonthlyResponse(
      page({
        data: [{
          Id: "55",
          Valor: 80,
          ValorFinal: 87.42,
          DescricaoRecebimento: "ABERTO"
        }]
      }),
      "55"
    );

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.paymentStatusSource).toBe("erp_open_invoice");
    expect(result.totalPendingAmountCents).toBe(8000);
    expect(result.totalPaidAmountCents).toBe(0);
    expect(result.installments[0]).toMatchObject({
      installmentCode: "55",
      baseAmountCents: 8000,
      finalAmountCents: 8742,
      paidAmountCents: null,
      paymentDescription: "ABERTO"
    });
  });

  it("ABERTO continua unpaid mesmo se ValorPago vier preenchido", () => {
    const result = analyzeMonthlyResponse(
      page({
        data: [{
          Id: "55",
          Valor: 100,
          ValorPago: 100,
          DescricaoRecebimento: "ABERTO"
        }]
      }),
      "55"
    );

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.installments[0]?.paidAmountCents).toBeNull();
  });

  it("classifica como paid quando DescricaoRecebimento nao e ABERTO e ValorPago esta informado", () => {
    const result = analyzeMonthlyResponse(
      page({
        data: [{
          Id: "55",
          Valor: 100,
          ValorFinal: 125,
          ValorPago: 110,
          DescricaoRecebimento: "PIX"
        }]
      }),
      "55"
    );

    expect(result.paymentStatus).toBe("paid");
    expect(result.paymentStatusSource).toBe("erp_explicit");
    expect(result.totalPendingAmountCents).toBe(0);
    expect(result.totalPaidAmountCents).toBe(11000);
    expect(result.installments[0]?.paidAmountCents).toBe(11000);
  });

  it("aceita pagamento exatamente igual ao Valor", () => {
    const result = analyzeMonthlyResponse(
      page({
        data: [{
          Id: "55",
          Valor: 100,
          ValorPago: 100,
          DescricaoRecebimento: "BOLETO"
        }]
      }),
      "55"
    );

    expect(result.paymentStatus).toBe("paid");
  });

  it("rejeita pagamento parcial quando ValorPago e inferior ao Valor", () => {
    expect(() => analyzeMonthlyResponse(
      page({
        data: [{
          Id: "55",
          Valor: 100,
          ValorPago: 99.99,
          DescricaoRecebimento: "PIX"
        }]
      }),
      "55"
    )).toThrow("ValorPago inferior ao Valor");
  });

  it("rejeita DescricaoRecebimento diferente de ABERTO sem ValorPago", () => {
    expect(() => analyzeMonthlyResponse(
      page({
        data: [{
          Id: "55",
          Valor: 100,
          DescricaoRecebimento: "PIX"
        }]
      }),
      "55"
    )).toThrow("sem ValorPago informado");
  });

  it("rejeita parcela alvo sem DescricaoRecebimento", () => {
    expect(() => analyzeMonthlyResponse(
      page({
        data: [{ Id: "55", Valor: 100, ValorPago: 100 }]
      }),
      "55"
    )).toThrow("nao possui DescricaoRecebimento");
  });

  it("rejeita parcela alvo sem Valor", () => {
    expect(() => analyzeMonthlyResponse(
      page({
        data: [{ Id: "55", DescricaoRecebimento: "ABERTO" }]
      }),
      "55"
    )).toThrow("nao possui Valor");
  });

  it("rejeita parcela alvo ausente mesmo quando a consulta esta completa", () => {
    expect(() => analyzeMonthlyResponse(
      page({ totalPages: 0, totalCount: 0, pageSize: 0, data: [] }),
      "55"
    )).toThrow("parcela alvo 55 nao foi localizada");
  });

  it("rejeita parcela alvo ausente quando ainda existem paginas nao consultadas", () => {
    expect(() => analyzeMonthlyResponse(
      page({
        totalPages: 2,
        totalCount: 2,
        pageSize: 1,
        data: [{ Id: "99", Valor: 50, DescricaoRecebimento: "ABERTO" }]
      }),
      "55"
    )).toThrow("consulta paginada do ERP nao foi concluida");
  });

  it("permite classificar a parcela quando ela e encontrada antes do fim da paginacao", () => {
    const result = analyzeMonthlyResponse(
      page({
        totalPages: 5,
        totalCount: 500,
        pageSize: 200,
        data: [{
          Id: "55",
          Valor: 100,
          ValorPago: 100,
          DescricaoRecebimento: "PIX"
        }]
      }),
      "55"
    );

    expect(result.paymentStatus).toBe("paid");
    expect(result.paginationComplete).toBe(false);
  });

  it("usa o vencimento do upload quando o ERP nao informa vencimento", () => {
    const result = analyzeMonthlyResponse(
      page({
        data: [{ Id: "55", Valor: 80, DescricaoRecebimento: "ABERTO" }]
      }),
      "55",
      "05/08/2026"
    );

    expect(result.installments[0]?.dueDate).toBe("05/08/2026");
  });

  it("prioriza DataVencimento da resposta do ERP", () => {
    const result = analyzeMonthlyResponse(
      page({
        data: [{
          Id: "55",
          DataVencimento: "2026-08-05",
          Valor: 80,
          DescricaoRecebimento: "ABERTO"
        }]
      }),
      "55",
      "05/08/2026"
    );

    expect(result.installments[0]?.dueDate).toBe("2026-08-05");
  });

  it("usa Valor, e nao ValorFinal, como valor pendente", () => {
    const result = analyzeMonthlyResponse(
      page({
        data: [{
          Id: "55",
          Valor: 80,
          ValorFinal: 87.42,
          DescricaoRecebimento: "ABERTO"
        }]
      }),
      "55"
    );

    expect(result.totalPendingAmountCents).toBe(8000);
    expect(result.installments[0]?.baseAmountCents).toBe(8000);
    expect(result.installments[0]?.finalAmountCents).toBe(8742);
  });

  it("normaliza o identificador da parcela entre numero e texto", () => {
    const result = analyzeMonthlyResponse(
      page({
        data: [{ Id: 55, Valor: 10, DescricaoRecebimento: "ABERTO" }]
      }),
      "55"
    );

    expect(result.paymentStatus).toBe("unpaid");
  });

  it("rejeita codigo funcional diferente de 1", () => {
    expect(() => analyzeMonthlyResponse(
      page({ codigo: 0, totalPages: 0, totalCount: 0, pageSize: 0, data: [] }),
      "55"
    )).toThrow("erro funcional");
  });

  it("rejeita erros funcionais preenchidos", () => {
    expect(() => analyzeMonthlyResponse(
      page({
        erros: [{ codigo: "ERP_ERROR" }],
        totalPages: 0,
        totalCount: 0,
        pageSize: 0,
        data: []
      }),
      "55"
    )).toThrow("erro funcional");
  });

  it("rejeita metadados de paginacao incoerentes", () => {
    expect(() => analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 2,
        TotalPages: 1,
        TotalCount: 0,
        PageSize: 0,
        Data: []
      },
      erros: null
    }, "55")).toThrow("metadados");
  });

  it("rejeita metadados ausentes", () => {
    expect(() => analyzeMonthlyResponse({
      codigo: 1,
      dados: { Data: [] },
      erros: null
    }, "55")).toThrow(MonthlyResponseError);
  });
});

describe("analyzeMonthlyResponses - paginacao", () => {
  it("consolida paginas ate localizar a parcela alvo", () => {
    const result = analyzeMonthlyResponses([
      page({
        currentPage: 1,
        totalPages: 2,
        totalCount: 2,
        pageSize: 1,
        data: [{ Id: "10", Valor: 45, DescricaoRecebimento: "ABERTO" }]
      }),
      page({
        currentPage: 2,
        totalPages: 2,
        totalCount: 2,
        pageSize: 1,
        data: [{
          Id: "55",
          Valor: 60,
          ValorPago: 60,
          DescricaoRecebimento: "PIX"
        }]
      })
    ], "55");

    expect(result.paymentStatus).toBe("paid");
    expect(result.paginationComplete).toBe(true);
    expect(result.totalPaidAmountCents).toBe(6000);
    expect(result.totalPendingAmountCents).toBe(4500);
  });

  it("rejeita pagamento parcial da parcela alvo mesmo com outras parcelas abertas", () => {
    expect(() => analyzeMonthlyResponses([
      page({
        currentPage: 1,
        totalPages: 2,
        totalCount: 2,
        pageSize: 1,
        data: [{ Id: "10", Valor: 45, DescricaoRecebimento: "ABERTO", Tipo_plano: "Plano A" }]
      }),
      page({
        currentPage: 2,
        totalPages: 2,
        totalCount: 2,
        pageSize: 1,
        data: [{
          Id: "55",
          Valor: 60,
          ValorPago: 50,
          DescricaoRecebimento: "PIX",
          Tipo_plano: "Plano A"
        }]
      })
    ], "55")).toThrow("ValorPago inferior ao Valor");
  });

  it("nao exige paginas restantes quando a parcela alvo ja foi encontrada", () => {
    const result = analyzeMonthlyResponses([
      page({
        currentPage: 1,
        totalPages: 4,
        totalCount: 400,
        pageSize: 100,
        data: [{ Id: "55", Valor: 90, DescricaoRecebimento: "ABERTO" }]
      })
    ], "55");

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.paginationComplete).toBe(false);
  });

  it("gera erro quando todas as paginas foram consultadas e a parcela alvo nao existe", () => {
    expect(() => analyzeMonthlyResponses([
      page({
        currentPage: 1,
        totalPages: 2,
        totalCount: 2,
        pageSize: 1,
        data: [{ Id: "10", Valor: 50, DescricaoRecebimento: "ABERTO" }]
      }),
      page({
        currentPage: 2,
        totalPages: 2,
        totalCount: 2,
        pageSize: 1,
        data: [{
          Id: "11",
          Valor: 60,
          ValorPago: 60,
          DescricaoRecebimento: "PIX"
        }]
      })
    ], "55")).toThrow("parcela alvo 55 nao foi localizada");
  });

  it("gera erro quando a parcela nao foi localizada e a paginacao esta incompleta", () => {
    expect(() => analyzeMonthlyResponses([
      page({
        currentPage: 1,
        totalPages: 3,
        totalCount: 3,
        pageSize: 1,
        data: [{ Id: "10", Valor: 50, DescricaoRecebimento: "ABERTO" }]
      })
    ], "55")).toThrow("consulta paginada do ERP nao foi concluida");
  });

  it("rejeita paginas com metadados incompativeis", () => {
    expect(() => analyzeMonthlyResponses([
      page({ currentPage: 1, totalPages: 2, totalCount: 2, pageSize: 1 }),
      page({ currentPage: 2, totalPages: 3, totalCount: 3, pageSize: 1 })
    ], "55")).toThrow("metadados incompativeis");
  });
});
