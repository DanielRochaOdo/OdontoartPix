import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

type ResumedJobRow = {
  id: string;
  batch_id: string;
  status: string;
};

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  try {
    const result = await dbQuery<ResumedJobRow>(
      `with target as (
         select id
           from processing_jobs
          where batch_id = $1
            and processing_origin = 'manual'
            and status = 'paused'
          order by created_at desc, id desc
          limit 1
       )
       update processing_jobs pj
          set status = 'queued',
              stop_requested_at = null,
              stop_requested_by = null,
              stop_reason = null,
              next_run_at = now(),
              finished_at = null,
              updated_at = now()
         from target
        where pj.id = target.id
       returning pj.id, pj.batch_id, pj.status`,
      [parsed.data.id]
    );

    const data = result.rows[0];
    if (!data) {
      return fail("NOT_FOUND", "Nenhum processamento manual pausado foi encontrado para o lote.", 404);
    }

    return ok(
      {
        jobId: data.id,
        batchId: data.batch_id,
        status: data.status
      },
      "Processamento retomado."
    );
  } catch (error) {
    console.error("[BATCH_RESUME_FAILED]", {
      batchId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível retomar o lote.", 500);
  }
}
