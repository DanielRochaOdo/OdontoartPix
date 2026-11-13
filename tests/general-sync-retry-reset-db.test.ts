import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { prepareBatchForGeneralSync } from "@/lib/general-sync-batch-preparation";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

function createPool() {
  return new Pool({
    host: process.env.DATABASE_HOST ?? "127.0.0.1",
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: process.env.DATABASE_NAME ?? "odontoart_pix_ci",
    user: process.env.DATABASE_USER ?? "postgres",
    password: process.env.DATABASE_PASSWORD ?? "postgres",
    max: 1
  });
}

async function withRollback<T>(run: (client: PoolClient) => Promise<T>) {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await run(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function createBatch(client: PoolClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const campaign = await client.query<{ id: string }>(
    "insert into campaigns(name) values ($1) returning id",
    ["Retry reset " + suffix]
  );
  const batch = await client.query<{ id: string }>(
    "insert into campaign_batches(campaign_id, name) values ($1::uuid, $2) returning id",
    [campaign.rows[0]!.id, "Retry " + suffix]
  );
  return { campaignId: campaign.rows[0]!.id, batchId: batch.rows[0]!.id };
}

async function createLink(
  client: PoolClient,
  ids: { campaignId: string; batchId: string },
  input: {
    processingStatus: string;
    paymentStatus: string | null;
    attempts: number;
    errorCode?: string | null;
  }
) {
  const suffix = randomUUID().replaceAll("-", "");
  const member = await client.query<{ id: string }>(
    "insert into members(cpf, cpf_hash, external_user_code) values ($1, $2, $3) returning id",
    [suffix.slice(0, 11), "retry-" + suffix, suffix.slice(0, 9)]
  );
  const link = await client.query<{ id: string }>(
    `insert into campaign_batch_members(
       campaign_id, batch_id, member_id, target_installment_id,
       processing_status, payment_status, processing_attempts, max_attempts,
       processing_error_code, last_error
     ) values ($1::uuid, $2::uuid, $3::uuid, '123456',
               $4, $5, $6, 3, $7, $8)
     returning id`,
    [
      ids.campaignId, ids.batchId, member.rows[0]!.id,
      input.processingStatus, input.paymentStatus, input.attempts,
      input.errorCode ?? null,
      input.errorCode ? "Timeout anterior" : null
    ]
  );
  return link.rows[0]!.id;
}

type LinkState = {
  processing_status: string;
  payment_status: string | null;
  processing_attempts: number;
  max_attempts: number;
  processing_error_code: string | null;
  last_error: string | null;
};

async function state(client: PoolClient, id: string) {
  const result = await client.query<LinkState>(
    `select processing_status, payment_status, processing_attempts,
            max_attempts, processing_error_code, last_error
       from campaign_batch_members where id = $1::uuid`,
    [id]
  );
  return result.rows[0]!;
}

describeDatabase("reset de tentativas no inicio de uma sincronizacao completa", () => {
  it("reabre erro esgotado, zera tentativas e nao toca em terminal, excluido ou ativo", async () => {
    await withRollback(async (client) => {
      const ids = await createBatch(client);
      const exhausted = await createLink(client, ids, {
        processingStatus: "error", paymentStatus: "unpaid",
        attempts: 3, errorCode: "ERP_TIMEOUT"
      });
      const completed = await createLink(client, ids, {
        processingStatus: "completed", paymentStatus: "unpaid", attempts: 2
      });
      const running = await createLink(client, ids, {
        processingStatus: "processing", paymentStatus: "unpaid", attempts: 2
      });
      const paid = await createLink(client, ids, {
        processingStatus: "completed", paymentStatus: "paid", attempts: 3
      });
      const agreed = await createLink(client, ids, {
        processingStatus: "completed", paymentStatus: "agreed", attempts: 3
      });
      const excluded = await createLink(client, ids, {
        processingStatus: "completed", paymentStatus: "excluded", attempts: 3
      });
      const removed = await createLink(client, ids, {
        processingStatus: "error", paymentStatus: "unpaid",
        attempts: 3, errorCode: "ERP_TIMEOUT"
      });
      await client.query(
        "update campaign_batch_members set deleted_at = now() where id = $1::uuid",
        [removed]
      );

      const protectedIds = [running, paid, agreed, excluded, removed];
      const before = await Promise.all(protectedIds.map((id) => state(client, id)));
      await prepareBatchForGeneralSync(ids.batchId, { resetAttempts: true, client });

      expect(await state(client, exhausted)).toMatchObject({
        processing_status: "pending",
        processing_attempts: 0,
        max_attempts: 3,
        processing_error_code: null,
        last_error: null
      });
      expect(await state(client, completed)).toMatchObject({
        processing_status: "pending",
        processing_attempts: 0,
        max_attempts: 3
      });
      for (const [index, id] of protectedIds.entries()) {
        expect(await state(client, id)).toEqual(before[index]);
      }

      // Uma nova onda tem novo orcamento de tentativas, sem aumentar max_attempts.
      await client.query(
        `update campaign_batch_members
            set processing_status = 'error',
                processing_attempts = 3,
                processing_error_code = 'ERP_TIMEOUT'
          where id = $1::uuid`,
        [exhausted]
      );
      await prepareBatchForGeneralSync(ids.batchId, { resetAttempts: true, client });
      expect(await state(client, exhausted)).toMatchObject({
        processing_status: "pending", processing_attempts: 0, max_attempts: 3
      });
    });
  });

  it("preserva o contador nos modos sem reinicio explicito", async () => {
    await withRollback(async (client) => {
      const ids = await createBatch(client);
      const exhausted = await createLink(client, ids, {
        processingStatus: "error", paymentStatus: "unpaid",
        attempts: 3, errorCode: "ERP_TIMEOUT"
      });
      await prepareBatchForGeneralSync(ids.batchId, { resetAttempts: false, client });
      expect(await state(client, exhausted)).toMatchObject({
        processing_status: "pending",
        processing_attempts: 3,
        processing_error_code: "ERP_TIMEOUT"
      });
    });
  });
});
