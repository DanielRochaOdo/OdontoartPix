import { describe, expect, it } from "vitest";
import {
  analyzeMonthlyResponse,
  analyzeMonthlyResponses,
  analyzeTargetInstallment,
  MonthlyResponseError
} from "@/lib/analysis";

describe("analyzeMonthlyResponse", () => {
  it("classifica como pago quando o contrato legado não traz cod_parcela", () => {
    const emptyResult = analyzeMonthlyResponse({ parcelas: [] });
    const withoutInstallmentCode = analyzeMonthlyResponse({
      parcelas: [{ cod_usuario: "A", cod_parcela: null, ValorFinal: 10 }]
    });

    expect(emptyResult.paymentStatus).toBe("paid");
    expect(emptyResult.totalPendingAmountCents).toBe(0);
    expect(withoutInstallmentCode.paymentStatus).toBe("paid");
    expect(withoutInstallmentCode.installmentsCount).toBe(0);
    expect(withoutInstallmentCode.totalPendingAmountCents).toBe(0);
  });

  it("classifica como não pago, soma ValorFinal e preserva os campos financeiros suportados", () => {
    const result = analyzeMonthlyResponse({
      parcelas: [
        {
          cod_usuario: "A-1",
          cod_parcela: "10",
          vencimento: "2025-12-01",
          tipo_parcela: "Mensalidade",
          cod_boleto: "boleto",
          cod_pix: "pix",
          link_cartão: "https://example.com",
          Situacao: "ABERTO",
          Valor: "100,00",
          Multa: "2,00",
          Juros: "3,00",
          AcrescimoAvulso: "4,00",
          DescontoAvulso: "5,00",
          ValorFinal: "104,00",
          Tipo_plano: "Plano A",
          Observacao: "ok"
        },
        {
          cod_usuario: "A-1",
          cod_parcela: "11",
          ValorFinal: "50,00",
          Tipo_plano: "Plano A"
        }
      ]
    });

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.installmentsCount).toBe(2);
    expect(result.totalPendingAmountCents).toBe(15400);
    expect(result.installments[0]).toMatchObject({
      installmentCode: "10",
      paidAmountCents: null,
      baseAmountCents: 10000,
      fineAmountCents: 200,
      interestAmountCents: 300,
      additionalAmountCents: 400,
      discountAmountCents: 500,
      finalAmountCents: 10400,
      planType: "Plano A"
    });
  });

  it("ignora parcelas duplicadas pela combinação de usuário e cod_parcela", () => {
    const result = analyzeMonthlyResponse({
      parcelas: [
        { cod_usuario: "A", cod_parcela: "1", ValorFinal: 10 },
        { cod_usuario: "A", cod_parcela: "1", ValorFinal: 10 },
        { cod_usuario: "B", cod_parcela: "1", ValorFinal: 20 }
      ]
    });

    expect(result.installmentsCount).toBe(2);
    expect(result.totalPendingAmountCents).toBe(3000);
  });

  it("não considera cod_parcela vazio como parcela financeira", () => {
    const result = analyzeMonthlyResponse({
      parcelas: [
        { cod_usuario: "A", cod_parcela: "", ValorFinal: 10 },
        { cod_usuario: "A", cod_parcela: "1", ValorFinal: 20 }
      ]
    });

    expect(result.installmentsCount).toBe(1);
    expect(result.totalPendingAmountCents).toBe(2000);
  });

  it("ignora parcelas do tipo Parcela Virtual em toda a leitura", () => {
    const result = analyzeMonthlyResponse({
      parcelas: [
        {
          cod_usuario: "A",
          cod_parcela: "1",
          tipo_parcela: "Parcela Virtual",
          ValorFinal: 100
        },
        {
          cod_usuario: "A",
          cod_parcela: "2",
          tipo_parcela: "Mensalidade",
          ValorFinal: 20
        }
      ]
    });

    expect(result.installmentsCount).toBe(1);
    expect(result.totalPendingAmountCents).toBe(2000);
    expect(result.installments[0]?.installmentCode).toBe("2");
  });

  it("agrupa parcelas por Tipo_plano", () => {
    const result = analyzeMonthlyResponse({
      parcelas: [
        { cod_parcela: "1", Tipo_plano: "Plano B", ValorFinal: 30 },
        { cod_parcela: "2", Tipo_plano: "Plano B", ValorFinal: 20 },
        { cod_parcela: "3", Tipo_plano: "Plano C", ValorFinal: 10 }
      ]
    });

    expect(result.totalsByPlan).toEqual([
      { planType: "Plano B", installmentsCount: 2, totalAmountCents: 5000 },
      { planType: "Plano C", installmentsCount: 1, totalAmountCents: 1000 }
    ]);
  });

  it("rejeita resposta sem parcelas em formato de array", () => {
    expect(() => analyzeMonthlyResponse({ parcelas: null })).toThrow(MonthlyResponseError);
  });

  it("nao confirma pagamento quando a parcela alvo nao aparece em dados.Data", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: { CurrentPage: 1, TotalPages: 0, TotalCount: 0, PageSize: 0, Data: [] },
      erros: null
    }, "55");

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.paginationComplete).toBe(true);
  });

  it("usa o vencimento do upload quando a API paginada nao informa vencimento", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{ Id: "55", Valor: 80, ValorFinal: 87.42, DescricaoRecebimento: "ABERTO" }]
      },
      erros: null
    }, "55", "05/08/2026", { historyComplete: true });

    expect(result.installments[0]?.dueDate).toBe("05/08/2026");
  });

  it("normaliza DataVencimento da resposta paginada como vencimento", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{ Id: "55", DataVencimento: "2026-08-05", Valor: 80, ValorFinal: 87.42, DescricaoRecebimento: "ABERTO" }]
      },
      erros: null
    }, "55", undefined, { historyComplete: true });

    expect(result.installments[0]?.dueDate).toBe("2026-08-05");
  });

  it("usa Valor, e não ValorFinal, como valor pendente da parcela alvo", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{ Id: "55", Valor: 80, ValorFinal: 87.42, DescricaoRecebimento: "ABERTO" }]
      },
      erros: null
    }, "55", undefined, { historyComplete: true });

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.totalPendingAmountCents).toBe(8000);
    expect(result.installments[0]?.baseAmountCents).toBe(8000);
    expect(result.installments[0]?.finalAmountCents).toBe(8742);
  });

  it("mantém ValorPago como recebido e zera pendência quando a target está paga", () => {
    const result = analyzeMonthlyResponse({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{ Id: "55", Valor: 100, ValorFinal: 125, ValorPago: 110, DescricaoRecebimento: "PIX" }]
      },
      erros: null
    }, "55", undefined, { historyComplete: true });

    expect(result.paymentStatus).toBe("paid");
    expect(result.totalPendingAmountCents).toBe(0);
    expect(result.totalPaidAmountCents).toBe(11000);
    expect(result.installments[0]?.baseAmountCents).toBe(10000);
    expect(result.installments[0]?.paidAmountCents).toBe(11000);
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
    }, "55", undefined, { historyComplete: true })).toThrow("não possui Valor");
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
          { Id: "55", Valor: 90, ValorFinal: 100, DescricaoRecebimento: "ABERTO" },
          { Id: "99", Valor: 75, ValorFinal: 75, ValorPago: 75, DescricaoRecebimento: "PIX" }
        ]
      },
      erros: null
    }, "55", undefined, { historyComplete: true });

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.totalPendingAmountCents).toBe(9000);
    expect(result.totalPaidAmountCents).toBe(7500);
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
          PageSize: 200,
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