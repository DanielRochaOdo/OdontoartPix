import { describe, expect, it } from "vitest";
import { mapDeletionError } from "@/lib/deletions/error-mapper";

describe("mapDeletionError", () => {
  it("mapeia campanha em processamento para conflito", () => {
    expect(mapDeletionError({ message: "campaign_running" }, "campanha")).toEqual({
      code: "CONFLICT",
      message: "A campanha possui um processamento em andamento. Finalize ou cancele o processamento antes de excluir.",
      status: 409
    });
  });

  it("mapeia lote inexistente para não encontrado", () => {
    expect(mapDeletionError({ message: "batch_not_found" }, "lote").status).toBe(404);
  });

  it("mapeia função ausente para indisponibilidade do banco", () => {
    const result = mapDeletionError(
      { code: "PGRST202", message: "Could not find the function public.delete_campaign_permanently" },
      "campanha"
    );

    expect(result.status).toBe(503);
    expect(result.message).toContain("migrations pendentes");
  });

  it("não expõe detalhes internos em erro desconhecido", () => {
    const result = mapDeletionError(
      { code: "XX000", message: "sensitive database detail" },
      "lote"
    );

    expect(result.status).toBe(500);
    expect(result.message).not.toContain("sensitive");
  });
});
