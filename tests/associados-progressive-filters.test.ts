import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dbQuery } from "@/lib/db/pool";
import { getAssociadosCardFilterOptionFacet } from "@/lib/associados-paginated";

vi.mock("@/lib/db/pool", () => ({ dbQuery: vi.fn() }));
const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Associados: aplicação progressiva de filtros", () => {
  it("lista os cards sem aguardar as facetas; consulta opções separadamente ao abrir um filtro", () => {
    const route = source("src/app/api/associados/lista/route.ts");
    const lazy = source("src/app/api/associados/opcoes/route.ts");
    const component = source("src/components/associados-card-list.tsx");
    expect(route).toContain("await getAssociadosCardPage(");
    expect(route).not.toContain("getAssociadosCardFilterOptions");
    expect(lazy).toContain("getAssociadosCardFilterOptionFacet");
    expect(lazy).toContain("requireApiUser");
    expect(component).toContain('fetch("/api/associados/opcoes"');
    expect(component).toContain("onOpen={() => refreshFacetOptions");
    expect(component).toContain("controller.abort()");
    expect(component).toContain("loading ? \"Atualizando...\"");
    expect(component).not.toContain("setAvailableOptions(payload.data.filterOptions");
  });

  it("a faceta de campanha ignora só a campanha e preserva o lote selecionado", async () => {
    const mock = vi.mocked(dbQuery);
    mock.mockReset();
    mock.mockResolvedValue({ rows: [{ value: "camp-1", label: "Campanha 1" }] } as never);
    const data = await getAssociadosCardFilterOptionFacet({
      campaign: ["00000000-0000-0000-0000-000000000001"],
      batch: ["00000000-0000-0000-0000-000000000002"]
    }, "campaign");
    expect(data).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
    const [sql, params] = mock.mock.calls[0];
    expect(String(sql)).toContain("cbm.target_installment_ref_id = e.installment_id");
    expect(params?.[0]).toEqual([]);
    expect(params?.[1]).toEqual(["00000000-0000-0000-0000-000000000002"]);
  });

  it("a faceta de pagamento ignora só o próprio estado e mantém os outros filtros", async () => {
    const mock = vi.mocked(dbQuery);
    mock.mockReset();
    mock.mockResolvedValue({ rows: [{ value: "paid", label: "paid" }] } as never);
    await getAssociadosCardFilterOptionFacet({ payment: ["paid"], status: ["error"] }, "payment");
    expect(mock).toHaveBeenCalledTimes(1);
    const [sql, params] = mock.mock.calls[0];
    expect(String(sql)).toContain("select distinct payment_key as value");
    expect(params?.[10]).toEqual(["error"]);
    expect(params?.[11]).toEqual([]);
  });
});
