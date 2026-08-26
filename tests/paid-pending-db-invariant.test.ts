import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  return value;
}

function createIsolatedPool() {
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

async function withIsolatedTransaction<T>(task: (client: PoolClient) => Promise<T>) {
  const pool = createIsolatedPool();
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

async function createScenario(client: PoolClient, prefix: string) {
  const suffix = randomUUID().replaceAll("-", "");

  const campaign = await client.query<{ id: string }>(
    `insert into campaigns(name, status)
     values ($1, 'rascunho')
     returning id`,
    [`${prefix} ${suffix}`]
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
    [
      suffix.slice(0, 11),
      `hash-${suffix}`,
      `Associado ${suffix.slice(0, 6)}`,
      suffix.slice(0, 9)
    ]
  );

  return {
    campaignId,
    batchId,
    memberId: member.rows[0]!.id
  };
}

describeDatabase("paid pending database invariant", () => {
  it("preserva o saldo residual de pagamento explicito parcial", async () => {
    await withIsolatedTransaction(async (client) => {
      const { campaignId, batchId, memberId } = await createScenario(
        client,
        "Paid pending"
      );

      const inserted = await client.query<{
        id: string;
        total_pending_amount_cents: string;
      }>(
        `insert into campaign_batch_members(
           campaign_id,
           batch_id,
           member_id,
           target_installment_id,
           processing_status,
           payment_status,
           payment_status_source,
           installment_amount_cents,
           payment_amount_cents,
           total_pending_amount_cents
         ) values (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           '6591350',
           'completed',
           'paid',
           'erp_explicit',
           28800,
           20850,
           0
         )
         returning id, total_pending_amount_cents::text`,
        [campaignId, batchId, memberId]
      );

      const linkId = inserted.rows[0]!.id;
      expect(Number(inserted.rows[0]!.total_pending_amount_cents)).toBe(7950);

      const forcedZero = await client.query<{ total_pending_amount_cents: string }>(
        `update campaign_batch_members
            set total_pending_amount_cents = 0,
                updated_at = now()
          where id = $1::uuid
          returning total_pending_amount_cents::text`,
        [linkId]
      );
      expect(Number(forcedZero.rows[0]!.total_pending_amount_cents)).toBe(7950);

      const fullyPaid = await client.query<{ total_pending_amount_cents: string }>(
        `update campaign_batch_members
            set payment_amount_cents = 28800,
                total_pending_amount_cents = 999,
                updated_at = now()
          where id = $1::uuid
          returning total_pending_amount_cents::text`,
        [linkId]
      );
      expect(Number(fullyPaid.rows[0]!.total_pending_amount_cents)).toBe(0);
    });
  });

  it("nao reinterpreta pagamentos que nao vieram da verdade explicita do ERP", async () => {
    await withIsolatedTransaction(async (client) => {
      const { campaignId, batchId, memberId } = await createScenario(
        client,
        "Administrative payment"
      );

      const inserted = await client.query<{ total_pending_amount_cents: string }>(
        `insert into campaign_batch_members(
           campaign_id,
           batch_id,
           member_id,
           processing_status,
           payment_status,
           payment_status_source,
           installment_amount_cents,
           payment_amount_cents,
           total_pending_amount_cents
         ) values (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           'completed',
           'paid',
           'administrative',
           28800,
           0,
           0
         )
         returning total_pending_amount_cents::text`,
        [campaignId, batchId, memberId]
      );

      expect(Number(inserted.rows[0]!.total_pending_amount_cents)).toBe(0);
    });
  });
});
