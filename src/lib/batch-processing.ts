import { randomUUID } from "node:crypto";
import { isValidCpf, stripCpf } from "@/lib/cpf";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { consultMonthlyByCpf, ErpError } from "@/lib/mensalidades-api";

export type ProcessingBlockResult = {
  workerId: string;
  jobId: string | null;
  claimed: number;
  succeeded: number;
  failed: number;
  status: "idle" | "queued" | "completed" | "failed";
};

type ProcessingJob = {
  id: string;
  campaign_id: string;
  batch_id: string;
  status: string;
  total_items: number;
  processed_items: number;
  success_items: number;
  error_items: number;
  include_errors: boolean;
};

type ClaimedMember = {
  id: string;
  campaign_id: string;
  batch_id: string;
  member_id: string;
  processing_attempts: number;
};

type StoredMember = {
  id: string;
  cpf: string | null;
};

type MemberResult = { ok: true } | { ok: false };

function configuredInteger(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

async function countEligible(batchId: string, includeErrors: boolean) {
  const supabase = createSupabaseAdminClient();
  const statuses = includeErrors
    ? ["pending", "pendente", "aguardando", "error"]
    : ["pending", "pendente", "aguardando"];

  const { count, error } = await supabase
    .from("campaign_batch_members")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .is("deleted_at", null)
    .in("processing_status", statuses);

  if (error) throw error;
  return count ?? 0;
}

async function persistMemberError(
  claimed: ClaimedMember,
  code: string,
  message: string,
  httpStatus: number | null,
  durationMs: number | null
) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.rpc("persist_member_processing_error", {
    p_campaign_batch_member_id: claimed.id,
    p_error_code: code,
    p_error_message: message,
    p_http_status: httpStatus,
    p_duration_ms: durationMs
  });
  if (error) throw error;
}

async function processMember(
  claimed: ClaimedMember,
  membersById: Map<string, StoredMember>
): Promise<MemberResult> {
  const member = membersById.get(claimed.member_id);
  if (!member) {
    await persistMemberError(
      claimed,
      "MEMBER_NOT_FOUND",
      "O associado vinculado ao lote não foi localizado.",
      null,
      null
    );
    return { ok: false };
  }

  const cpf = stripCpf(member.cpf ?? "");
  if (!cpf) {
    await persistMemberError(
      claimed,
      "MEMBER_CPF_MISSING",
      "O associado não possui CPF.",
      null,
      null
    );
    return { ok: false };
  }
  if (!isValidCpf(cpf)) {
    await persistMemberError(
      claimed,
      "MEMBER_CPF_INVALID",
      "O CPF do associado é inválido.",
      null,
      null
    );
    return { ok: false };
  }

  const startedAt = Date.now();
  console.info("[ERP_REQUEST_STARTED]", {
    campaignId: claimed.campaign_id,
    batchId: claimed.batch_id,
    campaignBatchMemberId: claimed.id,
    memberId: claimed.member_id,
    attempt: claimed.processing_attempts
  });

  try {
    const consultation = await consultMonthlyByCpf(cpf);
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.rpc("persist_member_processing_success", {
      p_campaign_batch_member_id: claimed.id,
      p_http_status: consultation.httpStatus,
      p_duration_ms: consultation.durationMs,
      p_analysis: consultation.analysis
    });
    if (error) throw error;

    console.info("[MEMBER_RESULT_PERSISTED]", {
      campaignId: claimed.campaign_id,
      batchId: claimed.batch_id,
      campaignBatchMemberId: claimed.id,
      memberId: claimed.member_id,
      paymentStatus: consultation.analysis.paymentStatus,
      installmentsCount: consultation.analysis.installmentsCount,
      durationMs: consultation.durationMs
    });
    return { ok: true };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const code = error instanceof ErpError ? error.code : "PERSISTENCE_OR_UNKNOWN_ERROR";
    const message =
      error instanceof Error ? error.message : "Falha desconhecida durante o processamento.";
    const httpStatus = error instanceof ErpError ? error.httpStatus ?? null : null;

    await persistMemberError(claimed, code, message, httpStatus, durationMs);
    console.error("[MEMBER_PROCESSING_FAILED]", {
      campaignId: claimed.campaign_id,
      batchId: claimed.batch_id,
      campaignBatchMemberId: claimed.id,
      memberId: claimed.member_id,
      code,
      durationMs
    });
    return { ok: false };
  }
}

export async function processNextJobBlock(): Promise<ProcessingBlockResult> {
  const supabase = createSupabaseAdminClient();
  const workerId = randomUUID();
  const leaseSeconds = configuredInteger("PROCESSING_LEASE_SECONDS", 240, 30, 900);
  const blockSize = configuredInteger("PROCESSING_BLOCK_SIZE", 10, 1, 50);
  const concurrency = configuredInteger("PROCESSING_CONCURRENCY", 3, 1, 8);

  const { data: jobData, error: claimJobError } = await supabase.rpc(
    "claim_next_processing_job",
    {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds
    }
  );
  if (claimJobError) throw claimJobError;

  const job = ((jobData ?? []) as ProcessingJob[])[0];
  if (!job) {
    return {
      workerId,
      jobId: null,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      status: "idle"
    };
  }

  try {
    const { data: claimedData, error: claimMembersError } = await supabase.rpc(
      "claim_batch_members",
      {
        p_batch_id: job.batch_id,
        p_worker_id: workerId,
        p_limit: blockSize,
        p_include_errors: false
      }
    );
    if (claimMembersError) throw claimMembersError;

    const claimed = (claimedData ?? []) as ClaimedMember[];
    if (claimed.length === 0) {
      const remaining = await countEligible(job.batch_id, false);
      const finalStatus = remaining === 0 ? "completed" : "queued";
      const { error: finishError } = await supabase
        .from("processing_jobs")
        .update({
          status: finalStatus,
          finished_at: finalStatus === "completed" ? new Date().toISOString() : null,
          next_run_at: new Date().toISOString(),
          locked_by: null,
          last_heartbeat_at: new Date().toISOString(),
          lease_expires_at: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", job.id)
        .eq("locked_by", workerId);
      if (finishError) throw finishError;

      return {
        workerId,
        jobId: job.id,
        claimed: 0,
        succeeded: 0,
        failed: 0,
        status: finalStatus
      };
    }

    const memberIds = [...new Set(claimed.map((item) => item.member_id))];
    const { data: storedMembers, error: memberError } = await supabase
      .from("members")
      .select("id,cpf")
      .in("id", memberIds);
    if (memberError) throw memberError;

    const membersById = new Map(
      ((storedMembers ?? []) as StoredMember[]).map((member) => [member.id, member])
    );
    console.info("[CLAIMED_MEMBERS_HYDRATED]", {
      jobId: job.id,
      batchId: job.batch_id,
      claimed: claimed.length,
      hydrated: membersById.size
    });

    const results = await mapWithConcurrency(claimed, concurrency, (item) =>
      processMember(item, membersById)
    );
    const succeeded = results.filter((result) => result.ok).length;
    const failed = results.length - succeeded;
    const remaining = await countEligible(job.batch_id, false);
    const finalStatus = remaining === 0 ? "completed" : "queued";

    const { error: updateJobError } = await supabase
      .from("processing_jobs")
      .update({
        status: finalStatus,
        processed_items: job.processed_items + claimed.length,
        success_items: job.success_items + succeeded,
        error_items: job.error_items + failed,
        finished_at: finalStatus === "completed" ? new Date().toISOString() : null,
        next_run_at: new Date().toISOString(),
        locked_by: null,
        last_heartbeat_at: new Date().toISOString(),
        lease_expires_at: null,
        last_error: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", job.id)
      .eq("locked_by", workerId);
    if (updateJobError) throw updateJobError;

    console.info("[CRON_BLOCK_COMPLETED]", {
      workerId,
      jobId: job.id,
      batchId: job.batch_id,
      claimed: claimed.length,
      succeeded,
      failed,
      remaining,
      status: finalStatus
    });

    return {
      workerId,
      jobId: job.id,
      claimed: claimed.length,
      succeeded,
      failed,
      status: finalStatus
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida no worker.";
    await supabase
      .from("processing_jobs")
      .update({
        status: "failed",
        last_error: message.slice(0, 1000),
        finished_at: new Date().toISOString(),
        locked_by: null,
        lease_expires_at: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", job.id)
      .eq("locked_by", workerId);

    console.error("[CRON_JOB_FAILED]", {
      workerId,
      jobId: job.id,
      batchId: job.batch_id,
      message
    });

    return {
      workerId,
      jobId: job.id,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      status: "failed"
    };
  }
}
