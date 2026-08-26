import { describe, expect, it } from "vitest";
import {
  isPaidWithPending,
  matchesPaidPendingFilter,
  normalizePaidPendingFilter
} from "@/lib/paid-pending";

describe("paid pending filter", () => {
  it("considera pago com pendencia somente quando paid possui saldo positivo", () => {
    expect(isPaidWithPending("paid", 7950)).toBe(true);
    expect(isPaidWithPending("paid", 0)).toBe(false);
    expect(isPaidWithPending("unpaid", 7950)).toBe(false);
  });

  it("Sim retorna somente pagos com saldo residual", () => {
    expect(matchesPaidPendingFilter("paid", 7950, "yes")).toBe(true);
    expect(matchesPaidPendingFilter("paid", 0, "yes")).toBe(false);
    expect(matchesPaidPendingFilter("unpaid", 28800, "yes")).toBe(false);
  });

  it("Nao retorna somente registros sem pendencia", () => {
    expect(matchesPaidPendingFilter("paid", 0, "no")).toBe(true);
    expect(matchesPaidPendingFilter("paid", 7950, "no")).toBe(false);
    expect(matchesPaidPendingFilter("unpaid", 28800, "no")).toBe(false);
  });

  it("Selecione mantem todos os registros", () => {
    expect(normalizePaidPendingFilter(undefined)).toBe("all");
    expect(normalizePaidPendingFilter("invalid")).toBe("all");
    expect(matchesPaidPendingFilter("unpaid", 28800, "all")).toBe(true);
  });
});
