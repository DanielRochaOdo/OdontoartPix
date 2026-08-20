import { describe, expect, it } from "vitest";
import {
  analyzeMonthlyResponses,
  analyzeMonthlyResponse,
  analyzeTargetInstallment,
  MonthlyResponseError
} from "@/lib/analysis";

describe("analyzeMonthlyResponse", () => {
  it("classifica como pago quando parcelas é um array sem cod_parcela", () => {
    const result = analyzeMonthlyResponse({
      mensagem: "Usuário sem mensalidades em aberto.",
      parcelas: [{ Situacao: "ATIVO", Observacao: "Sem parcelas" }]
    });

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.installmentsCount).toBe(0);
    expect(result.totalPendingAmountCents).toBe(0);
    expect(result.installments).toEqual([]);
  });

  it("classifica como não pago, soma ValorFinal e preserva os campos financeiros", () => {
    const result = analyzeMonthlyResponse({
      parcelas: [
        {
          cod_usuario: "1",
          cod_parcela: "10",
          vencimento: "05/08/2026",
          tipo_parcela: "Plano",
          cod_boleto: "123",
          cod_pix: "pix",
          link_cartão: "https://pagamento.exemplo",
          Situacao: "ATIVO",
          Valor: 70,
          Multa: 1,
          Juros: 2,
          AcrescimoAvulso: 3,
          DescontoAvulso: 1.3,
          ValorFinal: 74.7,
          Tipo_plano: "Orto",
          Observacao: "Parcela aberta"
        }
      ]
    });

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.totalPendingAmountCents).toBe(7470);
    expect(result.totalsByPlan).toEqual([
      { planType: "Orto", installmentsCount: 1, totalAmountCents: 7470 }
    ]);
    expect(result.installments[0]).toMatchObject({
      installmentCode: "10",
      boletoCode: "123",
      pixCode: "pix",
      finalAmountCents: 7470,
      planType: "Orto"
    });
  });

  it("ignora parcelas duplicadas pela combinação de usuário e cod_parcela", () => {
    const parcelas = [
      { cod_usuario: "1", cod_parcela: "10", Tipo_plano: "Orto", ValorFinal: 74.7 },
      { cod_usuario: "1", cod_parcela: "10", Tipo_plano: "Orto", ValorFinal: 74.7 }
    ];
    const result = analyzeMonthlyResponse({ parcelas });

    expect(result.installmentsCount).toBe(1);
    expect(result.totalPendingAmountCents).toBe(7470);
    expect(result.warnings[0]).toContain("duplicada");
  });

  it("não considera cod_parcela vazio como parcela financeira", () => {
    const result = analyzeMonthlyResponse({ parcelas: [{ cod_parcela: "   " }] });
    expect(result.paymentStatus).toBe("unpaid");
  });

  it("ignora parcelas do tipo Parcela Virtual em toda a leitura", () => {
    const result = analyzeMonthlyResponse({
      parcelas: [
        {
          cod_usuario: "1",
          cod_parcela: "virtual-1",
          tipo_parcela: " Parcela Virtual ",
          ValorFinal: "valor invalido",
          Tipo_plano: "Orto"
        },
        {
          cod_usuario: "1",
          cod_parcela: "10",
          tipo_parcela: "Plano",
          ValorFinal: 50,
          Tipo_plano: "Orto"
        }
      ]
    });

    expect(result.installmentsCount).toBe(1);
    expect(result.totalPendingAmountCents).toBe(5000);
    expect(result.installments[0]?.installmentCode).toBe("10");
  });

  it("agrupa parcelas por Tipo_plano", () => {
    const result = analyzeMonthlyResponse({
      parcelas: [
        { cod_parcela: "10", Tipo_plano: "Orto", ValorFinal: 10 },
        { cod_parcela: "11", Tipo_plano: "Orto", ValorFinal: 20 },
        { cod_parcela: "12", Tipo_plano: "Clínico", ValorFinal: 30 }
      ]
    });

    expect(result.totalsByPlan).toEqual([
      { planType: "Orto", installmentsCount: 2, totalAmountCents: 3000 },
      { planType: "Clínico", installmentsCount: 1, totalAmountCents: 3000 }
    ]);
  });

  it("rejeita resposta sem parcelas em formato de array", () => {
    expect(() => analyzeMonthlyResponse({ mensagem: "ok" })).toThrow(
      MonthlyResponseError
    );
    expect(() => analyzeMonthlyResponse({ parcelas: null })).toThrow(
      MonthlyResponseError
    );
  });

  it("aceita o novo contrato com dados.Data vazio como associado pago", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      mensagem: null,
      dados: {
        RequestInfo: null,
        CurrentPage: 1,
        TotalPages: 0,
        TotalCount: 0,
        PageSize: 0,
        Data: []
      },
      erros: null
    }, "55");

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.installmentsCount).toBe(0);
    expect(result.totalPendingAmountCents).toBe(0);
  });

  it("usa o vencimento do upload quando a API paginada nao informa vencimento", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 10,
        Data: [{ Id: "55", Valor: 87.42, ValorFinal: 87.42 }]
      },
      erros: []
    }, "55", "15/08/2026");

    expect(result.installments[0].dueDate).toBe("15/08/2026");
  });

  it("normaliza DataVencimento da resposta paginada como vencimento", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 10,
        Data: [{ Id: "55", Valor: 87.42, ValorFinal: 87.42, DataVencimento: "06/08/2026" }]
      },
      erros: []
    }, "55");

    expect(result.installments[0].dueDate).toBe("06/08/2026");
  });

  it("usa Valor, e não ValorFinal, como valor pendente da parcela alvo", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      mensagem: null,
      dados: {
        RequestInfo: null,
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{ Id: "55", Valor: 80, ValorFinal: 87.42, DescricaoRecebimento: "ABERTO" }]
      },
      erros: null
    }, "55");

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.installmentsCount).toBe(1);
    expect(result.totalPendingAmountCents).toBe(8000);
    expect(result.totalsByPlan[0]?.totalAmountCents).toBe(8000);
    expect(result.installments[0]).toMatchObject({
      installmentCode: "55",
      baseAmountCents: 8000,
      finalAmountCents: 8742
    });
  });

  it("mantém ValorPago como recebido e zera pendência quando a target está paga", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{
          Id: "55",
          Valor: 100,
          ValorFinal: 125,
          ValorPago: 110,
          DescricaoRecebimento: "PIX"
        }]
      },
      erros: null
    }, "55");

    expect(result.paymentStatus).toBe("paid");
    expect(result.totalPendingAmountCents).toBe(0);
    expect(result.totalPaidAmountCents).toBe(11000);
    expect(result.installments[0]).toMatchObject({
      baseAmountCents: 10000,
      finalAmountCents: 12500,
      paidAmountCents: 11000
    });
  });

  it("rejeita a parcela alvo quando o ERP não informa Valor", () => {
    expect(() => analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{ Id: "55", ValorFinal: 87.42, DescricaoRecebimento: "ABERTO" }]
      },
      erros: null
    }, "55")).toThrow("não possui Valor");
  });

  it("usa o historico completo para distinguir ABERTO de pagamento confirmado", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 2,
        PageSize: 100,
        Data: [
          { Id: "55", Valor: 90, ValorFinal: 100, ValorPago: 0, DescricaoRecebimento: "ABERTO" },
          { Id: "56", Valor: 70, ValorFinal: 80, ValorPago: "75,00", DescricaoRecebimento: "PIX" }
        ]
      },
      erros: null
    }, "55", undefined, { historyComplete: true });

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.totalPendingAmountCents).toBe(9000);
    expect(result.totalPaidAmountCents).toBe(7500);
    expect(result.installments).toHaveLength(2);
    expect(result.installments[0]).toMatchObject({
      baseAmountCents: 9000,
      finalAmountCents: 10000
    });
    expect(result.installments[1]).toMatchObject({
      paymentDescription: "PIX",
      paidAmountCents: 7500
    });
  });

  it("nunca marca como pago um historico sem ValorPago preenchido", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{ Id: "55", Valor: 80, ValorFinal: 87.42, DescricaoRecebimento: "QUITADO" }]
      },
      erros: null
    }, "55", undefined, { historyComplete: true });

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.installments[0]?.paidAmountCents).toBeNull();
    expect(result.totalPendingAmountCents).toBe(8000);
  });

  it("nao usa Situacao como tipo de pagamento quando DescricaoRecebimento nao veio", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{ Id: "55", Valor: 80, ValorFinal: 87.42, Situacao: "ATIVO" }]
      },
      erros: null
    }, "55", undefined, { historyComplete: true });

    expect(result.installments[0]?.situation).toBeUndefined();
    expect(result.installments[0]?.paymentDescription).toBeUndefined();
    expect(result.paymentStatus).toBe("unpaid");
  });

  it("rejeita parcela financeira com ValorFinal inválido", () => {
    expect(() =>
      analyzeMonthlyResponse({ parcelas: [{ cod_parcela: "10", ValorFinal: "abc" }] })
    ).toThrow("ValorFinal inválido");
  });
});

describe("analise da fatura alvo e completude da paginacao", () => {
  it("consolida paginas e encontra a parcela alvo na pagina seguinte", () => {
    const result = analyzeMonthlyResponses([
      {
        codigo: 1,
        dados: {
          CurrentPage: 1,
          TotalPages: 2,
          TotalCount: 201,
          PageSize: 200,
          Data: [{ Id: "55", Valor: 45, ValorFinal: 49, DescricaoRecebimento: "ABERTO" }]
        },
        erros: null
      },
      {
        codigo: 1,
        dados: {
          CurrentPage: 2,
          TotalPages: 2,
          TotalCount: 201,
          PageSize: 66,
          Data: [{ Id: "999", Valor: 60, ValorFinal: 63.8, ValorPago: 63.8, DescricaoRecebimento: "PIX" }]
        },
        erros: null
      }
    ], "999", undefined, { historyComplete: true });

    expect(result.paymentStatus).toBe("paid");
    expect(result.paginationComplete).toBe(true);
    expect(result.totalPaidAmountCents).toBe(6380);
    expect(result.totalPendingAmountCents).toBe(4500);
  });

  it("analisa um conjunto de paginas sem depender do transporte HTTP", () => {
    const result = analyzeTargetInstallment({
      targetInstallmentId: "55",
      invoices: [{ id: 55, finalAmountCents: 1000 }, { id: 99, finalAmountCents: 2000 }],
      paginationComplete: true
    });

    expect(result.paymentStatus).toBe("unpaid");
  });

  it("ignora outras faturas quando o alvo nao esta na resposta completa", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{ Id: 999, ValorFinal: 87.42 }]
      }
    }, "55");

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.paymentStatusSource).toBe("erp_open_invoice");
  });

  it("nao conclui pagamento quando ainda existem paginas nao consultadas", () => {
    expect(() => analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 2,
        TotalCount: 2,
        PageSize: 1,
        Data: [{ Id: 999, ValorFinal: 87.42 }]
      }
    }, "55")).toThrow("consulta paginada");
  });

  it("normaliza o identificador alvo entre numero e texto", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 1,
        Data: [{ Id: 55, Valor: 10, ValorFinal: 10 }]
      }
    }, "55");

    expect(result.paymentStatus).toBe("unpaid");
  });

  it("rejeita codigo funcional diferente de 1 mesmo com Data vazia", () => {
    expect(() => analyzeMonthlyResponse({
      codigo: 0,
      dados: { CurrentPage: 1, TotalPages: 0, TotalCount: 0, PageSize: 0, Data: [] },
      erros: null
    }, "55")).toThrow("erro funcional");
  });

  it("rejeita erros funcionais preenchidos mesmo com Data vazia", () => {
    expect(() => analyzeMonthlyResponse({
      codigo: 1,
      dados: { CurrentPage: 1, TotalPages: 0, TotalCount: 0, PageSize: 0, Data: [] },
      erros: [{ codigo: "ERP_ERROR" }]
    }, "55")).toThrow("erro funcional");
  });

  it("rejeita metadados de pagina incoerentes", () => {
    expect(() => analyzeMonthlyResponse({
      codigo: 1,
      dados: { CurrentPage: 2, TotalPages: 1, TotalCount: 0, PageSize: 0, Data: [] },
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
