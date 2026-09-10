import { describe, expect, it } from "vitest";
import {
  buildAssociadosWorkbook,
  buildSummaryAnalysisWorkbook,
  EXPORT_ACCOUNTING_FORMAT
} from "@/lib/export-workbooks";
import { buildSummaryAnalysisPdf } from "@/lib/summary-analysis-pdf";

const entity = {
  dispatchCount: 100,
  dispatchValueCents: 250000,
  actionCostCents: 700,
  paidAssociateCount: 32,
  paidInstallmentCount: 35,
  paidAmountCents: 98000,
  paidAssociatePercentage: 32,
  paidInstallmentPercentage: 35,
  paidPercentage: 39.2,
  netAmountCents: 97300
};

const pixEntity = {
  dispatchValueCents: 125000,
  paidAssociateCount: 16,
  paidInstallmentCount: 18,
  paidAmountCents: 49000
};

describe("exportações do sistema", () => {
  it("mantém valores somáveis e deixa filtros de Associados em seis colunas com estilo", () => {
    const workbook = buildAssociadosWorkbook({
      generatedAt: new Date("2026-09-10T12:00:00Z"),
      filters: [
        { label: "Campanha", value: "SETEMBRO_26" },
        { label: "Data de pagamento", value: "Todas as datas" }
      ],
      rows: [{
        name: "Associado teste",
        associatedCode: "123",
        installment: "1",
        dueDate: "10/09/2026",
        cpf: "***.***.***-00",
        campaign: "SETEMBRO_26",
        batch: "LOTE 1",
        status: "Concluído",
        payment: "Pago",
        receiptDescription: "PIX - CLINICO",
        installmentType: "Clínico",
        paymentDate: "09/09/2026",
        amountCents: 12345,
        paidAmountCents: 12000,
        pendingCents: 345
      }]
    });

    const worksheet = workbook.Sheets.Associados;
    expect(worksheet.A1.v).toBe("ODONTOPIX · ASSOCIADOS");
    expect(worksheet.A5.v).toBe("FILTROS APLICADOS");
    expect([worksheet.A6.v, worksheet.B6.v, worksheet.C6.v, worksheet.D6.v, worksheet.E6.v, worksheet.F6.v])
      .toEqual(["FILTRO", "CRITÉRIO", "FILTRO", "CRITÉRIO", "FILTRO", "CRITÉRIO"]);
    expect([worksheet.A7.v, worksheet.B7.v, worksheet.C7.v, worksheet.D7.v])
      .toEqual(["Campanha", "SETEMBRO_26", "Data de pagamento", "Todas as datas"]);
    expect(worksheet.A5.s?.fill?.fgColor?.rgb).toBe("0F766E");
    expect(worksheet.A6.s?.border?.bottom?.style).toBe("thin");
    expect(worksheet.A7.s?.fill?.fgColor?.rgb).toBe("CCFBF1");
    expect(worksheet.B7.s?.border?.right?.style).toBe("thin");

    for (const ref of ["M12", "N12", "O12"]) {
      expect(worksheet[ref].t).toBe("n");
      expect(worksheet[ref].z).toBe(EXPORT_ACCOUNTING_FORMAT);
      expect(worksheet[ref].s?.border?.bottom?.style).toBe("thin");
    }
    expect(worksheet.M12.v).toBe(123.45);
    expect(worksheet.N12.v).toBe(120);
    expect(worksheet.O12.v).toBe(3.45);
  });

  it("gera XLSX de Resumo e Análise em cards, com cores, bordas e filtros compactos", () => {
    const workbook = buildSummaryAnalysisWorkbook({
      generatedAt: new Date("2026-09-10T12:00:00Z"),
      filters: [
        { label: "Campanha", value: "SETEMBRO_26" },
        { label: "Lote", value: "LOTE 1" },
        { label: "Data de vencimento", value: "01/09/2026 a 10/09/2026" },
        { label: "Data de pagamento", value: "Todas as datas" }
      ],
      clinico: entity,
      orto: entity,
      combined: entity,
      robo: entity,
      roboClinico: pixEntity,
      roboOrto: pixEntity
    });

    const worksheet = workbook.Sheets["Resumo e Análise"];
    expect(worksheet.A1.v).toBe("ODONTOPIX · RESUMO E ANÁLISE");
    expect(worksheet.A5.v).toBe("FILTROS APLICADOS");
    expect([worksheet.A6.v, worksheet.B6.v, worksheet.C6.v, worksheet.D6.v, worksheet.E6.v, worksheet.F6.v])
      .toEqual(["FILTRO", "CRITÉRIO", "FILTRO", "CRITÉRIO", "FILTRO", "CRITÉRIO"]);
    expect([worksheet.A7.v, worksheet.B7.v, worksheet.C7.v, worksheet.D7.v, worksheet.E7.v, worksheet.F7.v])
      .toEqual(["Campanha", "SETEMBRO_26", "Lote", "LOTE 1", "Data de vencimento", "01/09/2026 a 10/09/2026"]);
    expect([worksheet.A8.v, worksheet.B8.v]).toEqual(["Data de pagamento", "Todas as datas"]);
    expect(worksheet.A12.v).toBe("CLÍNICO");
    expect(worksheet.E12.v).toBe("ORTO");
    expect(worksheet.I12.v).toBe("CLÍNICO + ORTO");
    expect(worksheet.M12.v).toBe("ROBÔ · PIX");
    expect(worksheet.A12.s?.fill?.fgColor?.rgb).toBe("0F766E");
    expect(worksheet.A13.s?.border?.bottom?.style).toBe("thin");
    expect(worksheet.B13.s?.fill?.fgColor?.rgb).toBe("FFFFFF");
    expect(worksheet["!merges"]?.length).toBeGreaterThan(10);
  });

  it("mantém PDF de Resumo e Análise aprovado com cards, filtros e detalhamento PIX", () => {
    const pdf = buildSummaryAnalysisPdf({
      generatedAt: new Date("2026-09-10T12:00:00Z"),
      filters: [
        { label: "Campanha", value: "SETEMBRO_26" },
        { label: "Lote", value: "LOTE 1" },
        { label: "Data de vencimento", value: "Todos os vencimentos" },
        { label: "Data de pagamento", value: "Todas as datas" }
      ],
      dispatchUnitCostCents: 7,
      clinico: entity,
      orto: entity,
      combined: entity,
      robo: entity,
      roboClinico: pixEntity,
      roboOrto: pixEntity
    }).toString("ascii");

    expect(pdf).toContain("FILTROS APLICADOS");
    expect(pdf).toContain("CLINICO + ORTO");
    expect(pdf).toContain("ROBO");
    expect(pdf).toContain("CLINICO");
    expect(pdf).toContain("/Helvetica-Bold");
    expect(pdf).toContain("SETEMBRO_26");
  });
});
