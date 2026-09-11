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
    const styledSheet = sheet as typeof sheet & Record<string, any>;

    expect(sheet).toBeTruthy();
    expect(styledSheet.A1?.v).toBe("ODONTOPIX · DISPAROS");
    expect(styledSheet.A2?.v).toBe("Exportação dos registros filtrados");
    expect(styledSheet.A5?.v).toBe("FILTROS APLICADOS");
    expect(styledSheet.A1?.s?.fill?.fgColor?.rgb).toBe("062B2B");
    expect(styledSheet.A5?.s?.fill?.fgColor?.rgb).toBe("0F766E");
    expect(styledSheet["!autofilter"]?.ref).toContain(":Q");
    expect(styledSheet["!cols"]).toHaveLength(17);

    const values = Object.values(styledSheet)
      .filter((cell) => cell && typeof cell === "object" && "v" in cell)
      .map((cell) => cell.v);
    expect(values).toContain("Qtde disparos");
    expect(values).toContain("Último disparo");
  });
});
