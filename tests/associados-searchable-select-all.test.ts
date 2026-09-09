import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("filtros pesquisaveis de Associados", () => {
  it("permite selecionar todas as opcoes visiveis com ou sem pesquisa", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/associados-card-list.tsx"),
      "utf8"
    );

    expect(source).toContain("const visibleValues = visibleOptions.map");
    expect(source).toContain("function toggleVisibleOptions()");
    expect(source).toContain("new Set(visibleValues)");
    expect(source).toContain("onChange(uniqueValues([...values, ...visibleValues]))");
    expect(source).toContain("checked={allVisibleSelected}");
    expect(source).toContain("disabled={visibleValues.length === 0}");
    expect(source).toContain("Selecionar todos os resultados de ${label}");
    expect(source).toContain("Selecionar todos de ${label}");
    expect(source).toContain("<span>Todos</span>");
    expect(source).toContain('placeholder="Pesquisar..."');
  });
});
