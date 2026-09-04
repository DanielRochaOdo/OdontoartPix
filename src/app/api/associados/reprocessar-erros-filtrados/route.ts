import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";

const BodySchema = z.object({ memberIds: z.array(z.string().uuid()).min(1).max(10000) });
const FILTERED_ERROR_PRIORITY = 80;

type EligibleRow = { id: string; campaign_id: string; batch_id: string };
type ActiveRunRow = { run_id: string; run_batch_status: string; processing_job_id: string | null };

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return fail("VALIDATION_ERROR", "Informe os associados com erro que devem ser reprocessados.", 400);
  }

  const memberIds = [...new Set(body.data.memberIds)];

  try {
    const result = await withTransaction(async (client) => {
      const eligibleResult = await clientQuery<EligibleRow>(
        client,
        `select id, campaign_id, batch_id
           from campaign_batch_members
          where id = any($1::uuid[])
            and deleted_at is null
            and processing_status = 'error'
            and (payment_status is null or payment_status not in ('paid', 'agreed', 'excluded'))
          order by id
          for update`,
        [memberIds]
      );
      const eligible = eligibleResult.rows;
      if (eligible.length === 0) return null;

      const requestResult = await clientQuery<{ id: string }>(
        client,
        `insert into filtered_error_reprocess_requests(
           requested_by, requested_count, batch_count, campaign_count, status
         ) values (
           $1::uuid, $2, $3, $4, 'queued'
         ) returning id`,
        [
          auth.profile.id,
          eligible.length,
          new Set(eligible.map((row) => row.batch_id)).size,
          new Set(eligible.map((row) => row.campaign_id)).size
        ]
      );
      const requestId = requestResult.rows[0]?.id;
      if (!requestId) throw new Error("FILTERED_ERROR_REQUEST_NOT_CREATED");

      await clientQuery(
        client,
        `insert into filtered_error_reprocess_items(
           request_id, member_link_id, campaign_id, batch_id, status
         )
         select $1::uuid, item.id, item.campaign_id, item.batch_id, 'queued'
           from jsonb_to_recordset($2::jsonb) as item(
             id uuid, campaign_id uuid, batch_id uuid
           )`,
        [requestId, JSON.stringify(eligible)]
      );

      const grouped = new Map<string, { campaignId: string; memberIds: string[] }>();
      for (const row of eligible) {
        const current = grouped.get(row.batch_id) ?? { campaignId: row.campaign_id, memberIds: [] };
        current.memberIds.push(row.id);
        grouped.set(row.batch_id, current);
      }

      let dashboardAbsorbedCount = 0;
      let manualBatchCount = 0;

      for (const [batchId, group] of grouped) {
        const activeRunResult = await clientQuery<ActiveRunRow>(
          client,
          `select gsr.id as run_id,
                  grb.status as run_batch_status,
                  grb.processing_job_id
             from general_sync_runs gsr
             join general_sync_run_batches grb on grb.run_id = gsr.id
            where grb.batch_id = $1::uuid
              and gsr.status in ('queued', 'running')
            order by gsr.created_at desc
            limit 1`,
          [batchId]
        );
        const activeRun = activeRunResult.rows[0] ?? null;

        await clientQuery(
          client,
          `update campaign_batch_members
              set processing_status = 'pending',
                  processing_attempts = 0,
                  stale_reclaim_count = 0,
                  processing_error_code = null,
                  next_retry_at = null,
                  next_check_at = now(),
                  error_reprocess_requested_at = null,
                  processing_owner = null,
                  processing_started_at = null,
                  processing_heartbeat_at = null,
                  claim_token = null,
                  claimed_at = null,
                  last_error = null,
                  updated_at = now()
            where id = any($1::uuid[])`,
          [group.memberIds]
        );

        if (activeRun && !["completed", "completed_with_errors", "failed", "cancelled"].includes(activeRun.run_batch_status)) {
          dashboardAbsorbedCount += group.memberIds.length;

          await clientQuery(
            client,
            `insert into dashboard_error_reprocess_items(
               request_id, run_id, batch_id, campaign_batch_member_id, status
             )
             select $1::uuid, $2::uuid, $3::uuid, member_id, 'queued'
               from unnest($4::uuid[]) member_id
             on conflict (request_id, campaign_batch_member_id) do nothing`,
            [requestId, activeRun.run_id, batchId, group.memberIds]
          );

          if (activeRun.processing_job_id) {
            await clientQuery(
              client,
              `update processing_jobs
                  set total_items = greatest(total_items + $2, processed_items + $2),
                      processing_priority = greatest(processing_priority, 100),
                      updated_at = now()
                where id = $1::uuid`,
              [activeRun.processing_job_id, group.memberIds.length]
            );
          }
          continue;
        }

        manualBatchCount += 1;
        await clientQuery(
          client,
          `insert into processing_jobs(
             campaign_id, batch_id, requested_by, status,
             total_items, processed_items, success_items, error_items,
             include_errors, processing_origin, processing_scope,
             processing_priority, filtered_error_request_id,
             next_run_at, created_at, updated_at
           ) values (
             $1::uuid, $2::uuid, $3::uuid, 'queued',
             $5, 0, 0, 0,
             false, 'manual', 'campaign',
             $6, $4::uuid,
             now(), now(), now()
           )`,
          [group.campaignId, batchId, auth.profile.id, requestId, group.memberIds.length, FILTERED_ERROR_PRIORITY]
        );
      }

      return {
        requestId,
        requestedCount: eligible.length,
        batchCount: grouped.size,
        campaignCount: new Set(eligible.map((row) => row.campaign_id)).size,
        dashboardAbsorbedCount,
        manualBatchCount
      };
    });

    if (!result) {
      return fail("CONFLICT", "Nenhum dos erros filtrados continua elegível para reprocessamento.", 422);
    }

    return ok(
      {
        ...result,
        scheduler: "systemd-timer"
      },
      result.dashboardAbsorbedCount === result.requestedCount
        ? `${result.requestedCount} erro(s) filtrados foram incorporados à onda ativa do dashboard.`
        : `${result.requestedCount} erro(s) filtrados foram registrados em um snapshot fechado para reprocessamento.`,
      202
    );
  } catch (error) {
    console.error("[FILTERED_ERROR_REPROCESS_REQUEST_FAILED]", {
      requestedCount: memberIds.length,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível iniciar o reprocessamento dos erros filtrados.", 500);
  }
}
