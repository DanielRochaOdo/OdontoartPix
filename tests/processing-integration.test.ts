import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  enqueueBatchJob,
  enqueueCampaignJobs,
  PROCESSING_PRIORITIES
} from "@/lib/batch-job-service";
import { getDbPool } from "@/lib/db/pool";
import { withTransaction } from "@/lib/db/transaction";
import { createLocalGeneralSyncRun } from "@/lib/general-sync-start";
import { queueMemberReprocess } from "@/lib/member-reprocess-queue";
import { resetProcessingConfigForTests } from "@/lib/processing-config";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

let requestedBy = "";

async function resetOperationalData() {
  await getDbPool().query(
    `truncate table campaigns, members, general_sync_runs, processing_jobs restart identity cascade`
  );
  resetProcessingConfigForTests();
}

async function createCampaign(name = "Regression campaign") {
  const result = await getDbPool().query<{ id: string }>(
    `insert into campaigns(name, status, created_by)
     values ($1, 'rascunho', $2::uuid)
     returning id`,
    [name, requestedBy]
  );
  return result.rows[0]!.id;
}

async function createBatch(campaignId: string, name: string) {
  const result = await getDbPool().query<{ id: string }>(
    `insert into campaign_batches(campaign_id, name, status, created_by)
     values ($1::uuid, $2, 'aguardando', $3::uuid)
     returning id`,
    [campaignId, name, requestedBy]
  );
  return result.rows[0]!.id;
}

async function createMemberLink(input: {
  campaignId: string;
  batchId: string;
  processingStatus?: string;
  paymentStatus?: string | null;
  targetInstallmentId?: string;
  lastError?: string | null;
}) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
  const memberResult = await getDbPool().query<{ id: string }>(
    `insert into members(cpf, cpf_hash, name, external_user_code)
     values ($1, $2, $3, $4)
     returning id`,
    [
      `9${suffix.slice(0, 10)}`,
      `hash-${suffix}`,
      `Associado ${suffix.slice(0, 6)}`,
      suffix.slice(0, 9)
    ]
  );
  const memberId = memberResult.rows[0]!.id;

  const linkResult = await getDbPool().query<{ id: string }>(
    `insert into campaign_batch_members(
       campaign_id, batch_id, member_id, target_installment_id,
       processing_status, payment_status, last_error, next_check_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4,
       $5, $6, $7, now()
     )
     returning id`,
    [
      input.campaignId,
      input.batchId,
      memberId,
      input.targetInstallmentId ?? String(6500000 + Math.floor(Math.random() * 100000)),
      input.processingStatus ?? "pending",
      input.paymentStatus ?? "unpaid",
      input.lastError ?? null
    ]
  );

  return {
    memberId,
    memberLinkId: linkResult.rows[0]!.id
  };
}

describeDatabase("processing integration regression", () => {
  beforeAll(async () => {
    const email = "ci-processing-regression@odontoart.test";
    await getDbPool().query(
      `insert into users(name, email, password_hash, role, active)
       values ('CI Processing Regression', $1, 'not-used', 'administrador', true)
       on conflict do nothing`,
      [email]
    );
    const user = await getDbPool().query<{ id: string }>(
      `select id from users where lower(email) = lower($1) limit 1`,
      [email]
    );
    requestedBy = user.rows[0]!.id;
  });

  beforeEach(async () => {
    await resetOperationalData();
  });

  afterAll(async () => {
    await resetOperationalData();
    await getDbPool().query(
      `delete from users where lower(email) = lower('ci-processing-regression@odontoart.test')`
    );
    await getDbPool().end();
  });

  it("associado: reprocessamento individual cria job fechado de exatamente um alvo", async () => {
    const campaignId = await createCampaign();
    const batchId = await createBatch(campaignId, "Lote associado");
    const { memberLinkId } = await createMemberLink({
      campaignId,
      batchId,
      processingStatus: "error",
      paymentStatus: "unpaid",
      targetInstallmentId: "6618828",
      lastError: "Erro anterior"
    });

    const job = await withTransaction(async (client) => queueMemberReprocess(
      client,
      {
        id: memberLinkId,
        campaign_id: campaignId,
        batch_id: batchId,
        target_installment_id: "6618828",
        payment_status: "unpaid"
      },
      requestedBy
    ));

    expect(job).not.toBeNull();

    const storedJob = await getDbPool().query<{
      processing_scope: string;
      target_member_link_id: string | null;
      total_items: number;
      processing_priority: number;
    }>(
      `select processing_scope, target_member_link_id, total_items, processing_priority
         from processing_jobs
        where id = $1::uuid`,
      [job!.id]
    );

    expect(storedJob.rows[0]).toMatchObject({
      processing_scope: "member",
      target_member_link_id: memberLinkId,
      total_items: 1,
      processing_priority: PROCESSING_PRIORITIES.member
    });

    const member = await getDbPool().query<{
      processing_status: string;
      processing_attempts: number;
      processing_error_code: string | null;
      last_error: string | null;
    }>(
      `select processing_status, processing_attempts, processing_error_code, last_error
         from campaign_batch_members
        where id = $1::uuid`,
      [memberLinkId]
    );

    expect(member.rows[0]).toMatchObject({
      processing_status: "pending",
      processing_attempts: 0,
      processing_error_code: null,
      last_error: null
    });
  });

  it("lote: cria somente um job batch com a quantidade elegivel", async () => {
    const campaignId = await createCampaign();
    const batchId = await createBatch(campaignId, "Lote regressao");
    await createMemberLink({ campaignId, batchId, processingStatus: "pending", paymentStatus: "unpaid" });
    await createMemberLink({ campaignId, batchId, processingStatus: "completed", paymentStatus: "paid" });

    const job = await enqueueBatchJob({
      campaignId,
      batchId,
      requestedBy,
      includeErrors: false,
      processingOrigin: "manual",
      processingScope: "batch",
      processingPriority: PROCESSING_PRIORITIES.batch
    });

    expect(job).toMatchObject({
      batch_id: batchId,
      total_items: 1,
      include_errors: false,
      processing_scope: "batch",
      processing_priority: PROCESSING_PRIORITIES.batch,
      created: true
    });
  });

  it("campanha: enfileira todos os lotes elegiveis mantendo escopo e prioridade", async () => {
    const campaignId = await createCampaign();
    const firstBatch = await createBatch(campaignId, "Lote campanha A");
    const secondBatch = await createBatch(campaignId, "Lote campanha B");
    await createMemberLink({ campaignId, batchId: firstBatch });
    await createMemberLink({ campaignId, batchId: secondBatch });
    await createMemberLink({ campaignId, batchId: secondBatch });

    const result = await enqueueCampaignJobs({
      campaignId,
      requestedBy,
      includeErrors: false,
      processingOrigin: "manual",
      processingScope: "campaign",
      processingPriority: PROCESSING_PRIORITIES.campaign
    });

    expect(result.found).toBe(true);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.reduce((sum, job) => sum + job.total_items, 0)).toBe(3);
    expect(result.jobs.every((job) => job.processing_scope === "campaign")).toBe(true);
    expect(result.jobs.every((job) => job.processing_priority === PROCESSING_PRIORITIES.campaign)).toBe(true);
  });

  it("dashboard: cria uma onda fechada com campanhas, lotes e registros do escopo", async () => {
    const campaignId = await createCampaign("Dashboard regression");
    const firstBatch = await createBatch(campaignId, "Dashboard A");
    const secondBatch = await createBatch(campaignId, "Dashboard B");
    await createMemberLink({ campaignId, batchId: firstBatch });
    await createMemberLink({ campaignId, batchId: secondBatch });
    await createMemberLink({ campaignId, batchId: secondBatch });

    const confirmationToken = `ci-${randomUUID()}`;
    const result = await createLocalGeneralSyncRun({
      campaignIds: [campaignId],
      batchIds: [],
      requestedBy,
      confirmationToken
    });

    expect(result.created).toBe(true);

    const run = await getDbPool().query<{
      scope_type: string;
      campaign_count: number;
      batch_count: number;
      record_count: number;
      status: string;
    }>(
      `select scope_type, campaign_count, batch_count, record_count, status
         from general_sync_runs
        where request_key = $1`,
      [confirmationToken]
    );

    expect(run.rows[0]).toMatchObject({
      scope_type: "filtered",
      campaign_count: 1,
      batch_count: 2,
      record_count: 3,
      status: "queued"
    });
  });

  it("reprocessamento total de erros: inclui todos os erros nao pagos da campanha e ignora pagos", async () => {
    const campaignId = await createCampaign("Errors regression");
    const firstBatch = await createBatch(campaignId, "Errors A");
    const secondBatch = await createBatch(campaignId, "Errors B");

    const firstError = await createMemberLink({
      campaignId,
      batchId: firstBatch,
      processingStatus: "error",
      paymentStatus: "unpaid",
      lastError: "ERP_INVALID_RESPONSE"
    });
    const secondError = await createMemberLink({
      campaignId,
      batchId: secondBatch,
      processingStatus: "error",
      paymentStatus: "unpaid",
      lastError: "ERP_INVALID_RESPONSE"
    });
    await createMemberLink({
      campaignId,
      batchId: secondBatch,
      processingStatus: "error",
      paymentStatus: "paid",
      lastError: "erro legado ja pago"
    });

    const result = await enqueueCampaignJobs({
      campaignId,
      requestedBy,
      includeErrors: true,
      processingOrigin: "manual",
      processingScope: "campaign",
      processingPriority: PROCESSING_PRIORITIES.campaign
    });

    expect(result.found).toBe(true);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.reduce((sum, job) => sum + job.total_items, 0)).toBe(2);
    expect(result.jobs.every((job) => job.include_errors)).toBe(true);

    const requested = await getDbPool().query<{ id: string }>(
      `select id
         from campaign_batch_members
        where id = any($1::uuid[])
          and error_reprocess_requested_at is not null
        order by id`,
      [[firstError.memberLinkId, secondError.memberLinkId]]
    );
    expect(requested.rows).toHaveLength(2);
  });
});
