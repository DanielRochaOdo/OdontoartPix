import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

export async function GET() {
  try {
    await dbQuery("select 1");
    return ok({ status: "ok" });
  } catch (error) {
    console.error("[DATABASE_HEALTH_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_UNAVAILABLE", "Banco de dados indisponível.", 503);
  }
}
