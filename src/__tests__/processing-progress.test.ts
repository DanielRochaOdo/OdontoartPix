import { describe, expect, it } from "vitest";
import { normalizeProcessingProgress } from "@/lib/processing-progress";

describe("normalizeProcessingProgress", () => {
  it("mantem contadores consistentes com o total do processamento", () => {
    expect(normalizeProcessingProgress({
      totalItems: 529,
      processedItems: 1400,
      successItems: 1400,
      errorItems: 0
    })).toEqual({
      totalItems: 529,
      processedItems: 529,
      successItems: 529,
      errorItems: 0
    });
  });

  it("não permite que sucessos e erros ultrapassem o total em conjunto", () => {
    expect(normalizeProcessingProgress({
      totalItems: 10,
      processedItems: 20,
      successItems: 8,
      errorItems: 5
    })).toEqual({
      totalItems: 10,
      processedItems: 10,
      successItems: 8,
      errorItems: 2
    });
  });
});
