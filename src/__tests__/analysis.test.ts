import { describe, expect, it } from "vitest";
import { analyzeMonthlyResponse } from "@/lib/analysis";

describe("analyzeMonthlyResponse", () => {
  it("resposta sem cod_parcela", () => {
    const result = analyzeMonthlyResponse({ parcelas: [{ Situacao: "ATIVO" }] });
    expect(result.paymentStatus).toBe("paid");
    expect(result.message).toContain("efetuou pagamento");
  });

  it("resposta com uma parcela", () => {
    const result = analyzeMonthlyResponse({ parcelas: [{ cod_usuario: "1", cod_parcela: "10", Tipo_plano: "Orto", ValorFinal: 74.7 }] });
    expect(result.paymentStatus).toBe("unpaid");
    expect(result.totalPendingAmountCents).toBe(7470);
  });

  it("parcelas duplicadas", () => {
    const result = analyzeMonthlyResponse({ parcelas: [{ cod_usuario: "1", cod_parcela: "10", Tipo_plano: "Orto", ValorFinal: 74.7 }, { cod_usuario: "1", cod_parcela: "10", Tipo_plano: "Orto", ValorFinal: 74.7 }] });
    expect(result.installmentsCount).toBe(1);
    expect(result.totalPendingAmountCents).toBe(7470);
  });

  it("sem Tipo_plano", () => {
    const result = analyzeMonthlyResponse({ parcelas: [{ cod_usuario: "1", cod_parcela: "10", ValorFinal: 10 }] });
    expect(result.totalsByPlan[0].planType).toBe("Não informado");
  });
});
