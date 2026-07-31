import { describe, expect, it } from "vitest";
import { calculateAverageTicketCents, formatCurrencyBR } from "@/lib/money";

describe("calculateAverageTicketCents", () => {
  it("cenario 1: calcula R$ 1.720,07 / 39 = R$ 44,10", () => {
    expect(calculateAverageTicketCents(172007, 39)).toBe(4410);
    expect(formatCurrencyBR(calculateAverageTicketCents(172007, 39))).toBe("R$ 44,10");
  });

  it("cenario 2: retorna R$ 0,00 quando valor pago e pagos sao zero", () => {
    expect(calculateAverageTicketCents(0, 0)).toBe(0);
    expect(formatCurrencyBR(calculateAverageTicketCents(0, 0))).toBe("R$ 0,00");
  });

  it("cenario 3: calcula R$ 500,00 / 1 = R$ 500,00", () => {
    expect(calculateAverageTicketCents(50000, 1)).toBe(50000);
    expect(formatCurrencyBR(calculateAverageTicketCents(50000, 1))).toBe("R$ 500,00");
  });

  it("cenario 4: calcula R$ 1.000,00 / 4 = R$ 250,00", () => {
    expect(calculateAverageTicketCents(100000, 4)).toBe(25000);
    expect(formatCurrencyBR(calculateAverageTicketCents(100000, 4))).toBe("R$ 250,00");
  });

  it("cenario 5: consolida duas campanhas sem media de medias", () => {
    const totalPaidAmountCents = 60000 + 90000;
    const paidCount = 10 + 20;

    expect(calculateAverageTicketCents(totalPaidAmountCents, paidCount)).toBe(5000);
    expect(formatCurrencyBR(calculateAverageTicketCents(totalPaidAmountCents, paidCount))).toBe("R$ 50,00");
  });
});
