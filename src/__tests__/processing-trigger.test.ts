import { describe, expect, it } from "vitest";
import { resolveIdleProcessingStatus } from "@/lib/processing-trigger";

describe("resolveIdleProcessingStatus", () => {
  it("mantem o worker ativo enquanto houver job na fila ou em execucao", () => {
    expect(resolveIdleProcessingStatus(1)).toBe("queued");
    expect(resolveIdleProcessingStatus(3)).toBe("queued");
  });

  it("retorna idle somente quando nao existe job ativo", () => {
    expect(resolveIdleProcessingStatus(0)).toBe("idle");
  });
});
