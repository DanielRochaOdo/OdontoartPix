import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  return value;
}

function createPool() {
  return new Pool({
    host: requiredEnv("DATABASE_HOST"),
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: requiredEnv("DATABASE_NAME"),
    user: requiredEnv("DATABASE_USER"),
    password: requiredEnv("DATABASE_PASSWORD"),
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    ssl:
      process.env.DATABASE_SSL?.toLowerCase() === "true"
        ? { rejectUnauthorized: false }
        : false
  });
}

async function withRollback<T>(task: (client: PoolClient) => Promise<T>) {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await task(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function createScenario(client: PoolClient) {
  const suffix = randomUUID().replaceAll("-", "");

  const campaign = await client.query<{ id: string }>(
    `insert into campaigns(name, status)
     values ($1, 'rascunho')
     returning id`,
    [`Wave ${suffix}`]
  );
  const campaignId = campaign.rows[0]!.id;

  const batch = await client.query<{ id: string }>(
    `insert into campaign_batches(campaign_id, name, status)
     values ($1::uuid, $2, 'aguardando')
     returning id`,
    [campaignId, `Lote ${suffix}`]
  );
  const batchId = batch.rows[0]!.id;

  const member = await client.query<{ id: string }>(
    `insert into members(cpf, cpf_hash, name, external_user_code)
     values ($1, $2, $3, $4)
     returning id`,
    [suffix.slice(0, 11), `hash-${suffix}`, `Associado ${suffix}`, suffix.slice(0, 9)]
  );

  const link = await client.query<{ id: string }>(
    `insert into campaign_batch_members(
       campaign_id,
       batch_id,
       member_id,
       target_installment_id,
       processing_status,
       payment_status,
       processing_attempts,
       max_attempts
     ) values (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       '123456',
       'pending',
       'unpaid',
       3,
       3
     )
     returning id`,
    [campaignId, batchId, member.rows[0]!.id]
  );

  const job = await client.query<{ id: string }>(
    `insert into processing_jobs(
       campaign_id,
       batch_id,
       status,
       total_items,
       processed_items,
       success_items,
       error_items,
       processing_origin,
       processing_scope,
       processing_priority
     ) values (
       $1::uuid,
       $2::uuid,
       'running',
       1,
       0,
       0,
       0,
       'dashboard',
       'dashboard',
       100
     )
     returning id`,
    [campaignId, batchId]
  );

  return {
    linkId: link.rows[0]!.id,
    jobId: job.rows[0]!.id
  };
}

describeDatabase("terminalizacao de limite por onda", () => {
  it("converte item esgotado em erro e fecha o job em 100%", async () => {
    await withRollback(async (client) => {
      const { linkId, jobId } = await createScenario(client);

      const finished = await client.query<{
        total_items: number;
        processed_items: number;
        success_items: number;
        error_items: number;
      }>(
        `update processing_jobs
            set status = 'completed',
                finished_at = now(),
                updated_at = now()
          where id = $1::uuid
          returning total_items, processed_items, success_items, error_items`,
        [jobId]
      );

      expect(finished.rows[0]).toMatchObject({
        total_items: 1,
        processed_items: 1,
        success_items: 0,
        error_items: 1
      });

      const member = await client.query<{
        processing_status: string;
        processing_error_code: string | null;
        processing_attempts: number;
      }>(
        `select processing_status, processing_error_code, processing_attempts
           from campaign_batch_members
          where id = $1::uuid`,
        [linkId]
      );

      expect(member.rows[0]).toMatchObject({
        processing_status: "error",
        processing_error_code: "PROCESSING_ATTEMPT_LIMIT",
        processing_attempts: 3
      });
    });
  });

  it("nao contabiliza o mesmo erro novamente em atualizacoes posteriores", async () => {
    await withRollback(async (client) => {
      const { jobId } = await createScenario(client);

      await client.query(
        `update processing_jobs
            set status = 'completed', updated_at = now()
          where id = $1::uuid`,
        [jobId]
      );

      const second = await client.query<{
        processed_items: number;
        error_items: number;
      }>(
        `update processing_jobs
            set updated_at = now()
          where id = $1::uuid
          returning processed_items, error_items`,
        [jobId]
      );

      expect(second.rows[0]).toMatchObject({
        processed_items: 1,
        error_items: 1
      });
    });
  });
});
