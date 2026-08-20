import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

export async function GET() {
  try {
    const result = await dbQuery<{ database_name: string; database_user: string }>(
      "select current_database() as database_name, current_user as database_user"
    );

    return ok({ database: result.rows[0] });
  } catch (error) {
    console.error("[DATABASE_HEALTH_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_UNAVAILABLE", "Banco de dados indisponível.", 503);
  }
}
