import { describe, expect, it } from "vitest";
import { parseInstallmentDueDate, sortInstallmentsNewestFirst } from "@/lib/installment-history";

describe("installment history", () => {
  it("interpreta formatos de vencimento usados pelo ERP e dados antigos", () => {
    expect(parseInstallmentDueDate("8/15/26")).toBe(Date.UTC(2026, 7, 15));
    expect(parseInstallmentDueDate("2026-08-15")).toBe(Date.UTC(2026, 7, 15));
    expect(parseInstallmentDueDate("15/08/2026")).toBe(Date.UTC(2026, 7, 15));
  });

  it("ordena parcelas do vencimento mais novo para o mais antigo", () => {
    const sorted = sortInstallmentsNewestFirst([
      { id: "older", due_date_text: "5/10/26", created_at: null },
      { id: "newer", due_date_text: "8/15/26", created_at: null },
      { id: "middle", due_date_text: "2026-07-01", created_at: null },
      { id: "without-date", due_date_text: null, created_at: null }
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      "newer",
      "middle",
      "older",
      "without-date"
    ]);
  });

  it("nao altera o array original", () => {
    const original = [
      { id: "a", due_date_text: "1/1/26" },
      { id: "b", due_date_text: "2/1/26" }
    ];

    const sorted = sortInstallmentsNewestFirst(original);

    expect(sorted.map((item) => item.id)).toEqual(["b", "a"]);
    expect(original.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
