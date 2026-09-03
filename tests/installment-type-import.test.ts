import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMemberFile } from "../src/lib/imports";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("installment type import", () => {
  it("normaliza Clinico/Clínico e Orto na planilha", async () => {
    const file = new File([
      [
        "Maria;1001;7001;120.50;12345678901;01/09/2026;Clínico",
        "Joao;1002;7002;80.00;98765432100;02/09/2026;ORTO"
      ].join("\n")
    ], "parcelas.txt", { type: "text/plain" });

    const result = await parseMemberFile(file);

    expect(result.issues).toHaveLength(0);
    expect(result.imports.map((item) => item.installmentType)).toEqual(["clinico", "orto"]);
  });

  it("rejeita linha sem Clinico ou Orto", async () => {
    const file = new File([
      "Maria;1001;7001;120.50;12345678901;01/09/2026;Implante"
    ], "parcelas.txt", { type: "text/plain" });

    const result = await parseMemberFile(file);

    expect(result.imports).toHaveLength(0);
    expect(result.issues[0]?.reason).toContain("Use Clinico ou Orto");
  });

  it("persiste o tipo somente na parcela canonica e protege conflito de reimportacao", () => {
    const migration = source("db/migrations/029_installment_clinical_ortho_type.sql");
    const importer = source("src/app/api/campanhas/importar-v2/route.ts");
    const importForm = source("src/components/campaign-import-form.tsx");

    expect(migration).toContain("add column if not exists installment_type text");
    expect(migration).toContain("installment_type in ('clinico', 'orto')");
    expect(importer).toContain("member_target_installments.installment_type is null");
    expect(importer).toContain("member_target_installments.installment_type = excluded.installment_type");
    expect(importer).toContain("classification_conflicts");
    expect(importForm).toContain("Tipo Parcela");
    expect(importForm).toContain("Clinico");
    expect(importForm).toContain("Orto");
  });
});
