import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/associados-card-list.tsx"),
  "utf8"
);

describe("Associados - UX de Acordado", () => {
  it("exibe agreed como Acordado no status de pagamento", () => {
    expect(source).toContain('agreed: "Acordado"');
    expect(source).toContain('normalized === "agreed" || normalized === "acordado"');
  });

  it("nao duplica Acordado em Tipo de Pagto", () => {
    expect(source).toContain('payment === "agreed"');
    expect(source).toContain('? "-"');
  });
});
