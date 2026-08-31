import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";

type ActiveRow = {
  id: string;
  active_request_count: number;
};

export async function GET() {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  try {
    const result = await dbQuery<ActiveRow>(
      `with active_requests as (
         select distinct r.id, r.created_at
           from associados_processing_requests r
           join associados_processing_items i on i.request_id = r.id
           join processing_jobs pj on pj.id = i.processing_job_id
          where pj.status in ('queued', 'running', 'paused', 'deferred')
       ), ranked as (
         select id,
                count(*) over()::int as active_request_count
           from active_requests
          order by created_at desc
          limit 1
       )
       select id, active_request_count from ranked`
    );

    const row = result.rows[0];
    return ok({
      requestId: row?.id ?? null,
      activeRequestCount: Number(row?.active_request_count ?? 0)
    });
  } catch (error) {
    console.error("[ASSOCIADOS_ACTIVE_PROCESSING_LOAD_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível consultar os processamentos ativos de associados.", 500);
  }
}
