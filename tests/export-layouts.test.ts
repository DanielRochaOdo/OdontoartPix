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
  it("mantém Valor, Valor pago e Pendência de Associados como números somáveis", () => {
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
    for (const ref of ["M12", "N12", "O12"]) {
      expect(worksheet[ref].t).toBe("n");
      expect(worksheet[ref].z).toBe(EXPORT_ACCOUNTING_FORMAT);
    }
    expect(worksheet.M12.v).toBe(123.45);
    expect(worksheet.N12.v).toBe(120);
    expect(worksheet.O12.v).toBe(3.45);
  });

  it("gera XLSX de Resumo e Análise em blocos equivalentes aos cards e com filtros", () => {
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
    expect(worksheet.A12.v).toBe("CLÍNICO");
    expect(worksheet.E12.v).toBe("ORTO");
    expect(worksheet.I12.v).toBe("CLÍNICO + ORTO");
    expect(worksheet.M12.v).toBe("ROBÔ · PIX");
    expect(worksheet["!merges"]?.length).toBeGreaterThan(10);
  });

  it("gera PDF de Resumo e Análise com cards, filtros e detalhamento PIX", () => {
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
