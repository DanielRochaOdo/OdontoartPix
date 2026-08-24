import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });
const MEMBER_PRIORITY = 40;

type MemberRow = {
  id: string;
  campaign_id: string;
  batch_id: string;
  target_installment_id: string | null;
  payment_status: string | null;
};

type JobRow = {
  id: string;
  status: string;
  processing_priority: number;
};

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Associado inválido.", 400);

  try {
    const result = await withTransaction(async (client) => {
      const memberResult = await clientQuery<MemberRow>(
        client,
        `select id, campaign_id, batch_id, target_installment_id, payment_status
           from campaign_batch_members
          where id = $1::uuid
            and deleted_at is null
          for update`,
        [parsed.data.id]
      );
      const member = memberResult.rows[0];
      if (!member) return { kind: "not_found" as const };
      if (!String(member.target_installment_id ?? "").trim()) {
        return { kind: "missing_target" as const };
      }
      if (member.payment_status === "paid") {
        return { kind: "paid" as const, member };
      }

      await clientQuery(
        client,
        `update campaign_batch_members
            set processing_status = 'pending',
                processing_attempts = 0,
                stale_reclaim_count = 0,
                next_check_at = now(),
                next_retry_at = null,
                error_reprocess_requested_at = null,
                processing_owner = null,
                processing_started_at = null,
                processing_heartbeat_at = null,
                claim_token = null,
                claimed_at = null,
                processing_error_code = null,
                last_error = null,
                updated_at = now()
          where id = $1::uuid`,
        [member.id]
      );

      const existing = await clientQuery<JobRow>(
        client,
        `select id, status, processing_priority
           from processing_jobs
          where target_member_link_id = $1::uuid
            and processing_origin = 'manual'
            and processing_scope = 'member'
            and status in ('queued', 'running', 'paused', 'deferred')
          order by created_at desc
          limit 1
          for update`,
        [member.id]
      );

      let job = existing.rows[0] ?? null;
      if (job) {
        const resumed = await clientQuery<JobRow>(
          client,
          `update processing_jobs
              set status = case when status in ('paused', 'deferred') then 'queued' else status end,
                  total_items = greatest(total_items, 1),
                  requested_by = $2::uuid,
                  next_run_at = now(),
                  stop_requested_at = null,
                  stop_requested_by = null,
                  stop_reason = null,
                  updated_at = now()
            where id = $1::uuid
          returning id, status, processing_priority`,
          [job.id, auth.profile.id]
        );
        job = resumed.rows[0] ?? job;
      } else {
        const inserted = await clientQuery<JobRow>(
          client,
          `insert into processing_jobs(
             campaign_id, batch_id, requested_by, status,
             total_items, processed_items, success_items, error_items,
             include_errors, processing_origin, processing_scope,
             processing_priority, target_member_link_id, next_run_at,
             created_at, updated_at
           ) values (
             $1::uuid, $2::uuid, $3::uuid, 'queued',
             1, 0, 0, 0,
             false, 'manual', 'member',
             $5, $4::uuid, now(), now(), now()
           )
           returning id, status, processing_priority`,
          [member.campaign_id, member.batch_id, auth.profile.id, member.id, MEMBER_PRIORITY]
        );
        job = inserted.rows[0] ?? null;
      }

      if (!job) throw new Error("MEMBER_REPROCESS_JOB_NOT_CREATED");
      return { kind: "queued" as const, member, job };
    });

    if (result.kind === "not_found") return fail("NOT_FOUND", "Associado não encontrado.", 404);
    if (result.kind === "missing_target") {
      return fail("VALIDATION_ERROR", "O associado não possui parcela de destino configurada.", 422);
    }
    if (result.kind === "paid") {
      return ok(
        {
          memberId: result.member.id,
          mode: "already_paid",
          targetInstallmentId: result.member.target_installment_id,
          queued: false
        },
        "A parcela alvo já está confirmada como paga; nenhum reprocessamento foi necessário."
      );
    }

    return ok(
      {
        memberId: result.member.id,
        mode: "member_job",
        jobId: result.job.id,
        batchId: result.member.batch_id,
        campaignId: result.member.campaign_id,
        targetInstallmentId: result.member.target_installment_id,
        priority: Number(result.job.processing_priority ?? MEMBER_PRIORITY),
        scope: "member",
        scheduler: "systemd-timer",
        queued: true
      },
      "Associado enfileirado para processamento com prioridade individual.",
      202
    );
  } catch (error) {
    console.error("[MEMBER_REPROCESS_QUEUE_FAILED]", {
      memberId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível enfileirar o reprocessamento do associado.", 500);
  }
}
