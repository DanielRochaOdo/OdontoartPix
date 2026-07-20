import { describe, expect, it } from "vitest";
import {
  analyzeMonthlyResponse,
  MonthlyResponseError
} from "@/lib/analysis";

 describe("analyzeMonthlyResponse", () => {
  it("classifica como pago quando parcelas é um array sem cod_parcela", () => {
    const result = analyzeMonthlyResponse({
      mensagem: "Usuário sem mensalidades em aberto.",
      parcelas: [{ Situacao: "ATIVO", Observacao: "Sem parcelas" }]
    });

    expect(result.paymentStatus).toBe("paid");
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
    expect(result.paymentStatus).toBe("paid");
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

  it("rejeita parcela financeira com ValorFinal inválido", () => {
    expect(() =>
      analyzeMonthlyResponse({ parcelas: [{ cod_parcela: "10", ValorFinal: "abc" }] })
    ).toThrow("ValorFinal inválido");
  });
});
