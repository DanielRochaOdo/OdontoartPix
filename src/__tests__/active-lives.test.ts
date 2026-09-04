import { describe, expect, it } from "vitest";
import { normalizeDataConsulta, parseActiveLivesPayload } from "@/lib/active-lives";

describe("active lives payload", () => {
  it("parses the expected API contract", () => {
    expect(
      parseActiveLivesPayload({
        totalVidasAtivas: 12345,
        totalTitularesAtivos: 7000,
        totalDependentesAtivos: 5345,
        dataConsulta: "04/09/2026 11:30:00"
      })
    ).toEqual({
      totalVidasAtivas: 12345,
      totalTitularesAtivos: 7000,
      totalDependentesAtivos: 5345,
      dataConsulta: "2026-09-04T14:30:00.000Z"
    });
  });

  it("accepts a data wrapper and numeric strings", () => {
    expect(
      parseActiveLivesPayload({
        data: {
          totalVidasAtivas: "100",
          totalTitularesAtivos: "60",
          totalDependentesAtivos: "40",
          dataConsulta: "2026-09-04T11:35:00-03:00"
        }
      })
    ).toMatchObject({
      totalVidasAtivas: 100,
      totalTitularesAtivos: 60,
      totalDependentesAtivos: 40
    });
  });

  it("assumes Fortaleza for an ISO timestamp without timezone", () => {
    expect(normalizeDataConsulta("2026-09-04T11:40:00")).toBe("2026-09-04T14:40:00.000Z");
  });

  it("rejects missing totals", () => {
    expect(() => parseActiveLivesPayload({ dataConsulta: "2026-09-04" })).toThrow(
      "totalVidasAtivas"
    );
  });
});
