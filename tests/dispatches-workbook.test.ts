import { describe, expect, it } from "vitest";
import { buildDispatchesWorkbook } from "@/lib/dispatches-workbook";

describe("XLSX de Disparos", () => {
  it("segue o mesmo padrão visual do XLSX de Associados", () => {
    const workbook = buildDispatchesWorkbook({
      generatedAt: new Date("2026-09-11T12:00:00-03:00"),
      filters: [
        { label: "Pagamento", value: "Não pago" },
        { label: "Campanha", value: "SETEMBRO_26" },
        { label: "Lote", value: "LOTE_01" }
      ],
      rows: [
        {
          name: "João Silva",
          associatedCode: "123",
          installment: "01/12",
          dueDate: "11/09/2026",
          cpf: "***.***.***-00",
          campaign: "SETEMBRO_26",
          batch: "LOTE_01",
          status: "Concluído",
          payment: "Não pago",
          receiptDescription: "PIX",
          installmentType: "Clínico",
          paymentDate: "",
          amountCents: 10000,
          paidAmountCents: 0,
          pendingCents: 10000,
          dispatchCount: 2,
          lastDispatchDate: "10/09/2026"
        }
      ]
    });

    const sheet = workbook.Sheets.Disparos;
    expect(sheet).toBeTruthy();
    expect(sheet.A1?.v).toBe("ODONTOPIX · DISPAROS");
    expect(sheet.A2?.v).toBe("Exportação dos registros filtrados");
    expect(sheet.A5?.v).toBe("FILTROS APLICADOS");
    expect(sheet.A1?.s?.fill?.fgColor?.rgb).toBe("062B2B");
    expect(sheet.A5?.s?.fill?.fgColor?.rgb).toBe("0F766E");
    expect(sheet["!autofilter"]?.ref).toContain(":Q");
    expect(sheet["!cols"]).toHaveLength(17);

    const cells = Object.values(sheet).filter(
      (cell): cell is { v?: unknown; s?: { fill?: { fgColor?: { rgb?: string } } } } =>
        Boolean(cell && typeof cell === "object" && "v" in cell)
    );
    expect(cells.some((cell) => cell.v === "Qtde disparos")).toBe(true);
    expect(cells.some((cell) => cell.v === "Último disparo")).toBe(true);
    expect(cells.some((cell) => cell.s?.fill?.fgColor?.rgb === "ECF7F5")).toBe(false);
  });
});
