import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  return value;
}

function pool() {
  return new Pool({
    host: requiredEnv("DATABASE_HOST"),
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: requiredEnv("DATABASE_NAME"),
    user: requiredEnv("DATABASE_USER"),
    password: requiredEnv("DATABASE_PASSWORD"),
    max: 1,
    ssl: process.env.DATABASE_SSL?.toLowerCase() === "true" ? { rejectUnauthorized: false } : false
  });
}

async function transaction<T>(task: (client: PoolClient) => Promise<T>) {
  const db = pool();
  const client = await db.connect();
  try {
    await client.query("begin");
    return await task(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await db.end();
  }
}

async function setup(client: PoolClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const campaign = await client.query<{ id: string }>(
    `insert into campaigns(name, status) values ($1, 'rascunho') returning id`,
    [`Race ${suffix}`]
  );
  const campaignId = campaign.rows[0]!.id;
  const batches = await client.query<{ id: string }>(
    `insert into campaign_batches(campaign_id, name, status)
     values ($1::uuid, $2, 'aguardando'), ($1::uuid, $3, 'aguardando')
     returning id`,
    [campaignId, `A ${suffix}`, `B ${suffix}`]
  );
  const member = await client.query<{ id: string }>(
    `insert into members(cpf, cpf_hash, name, external_user_code)
     values ($1, $2, $3, $4) returning id`,
    [suffix.slice(0, 11), `race-${suffix}`, `Race ${suffix.slice(0, 6)}`, suffix.slice(0, 9)]
  );

  const linkIds: string[] = [];
  for (const batch of batches.rows) {
    const link = await client.query<{ id: string }>(
      `insert into campaign_batch_members(
         campaign_id, batch_id, member_id, target_installment_id,
         installment_amount_cents, processing_status
       ) values ($1::uuid, $2::uuid, $3::uuid, 'RACE-1', 5000, 'pending')
       returning id`,
      [campaignId, batch.id, member.rows[0]!.id]
    );
    linkIds.push(link.rows[0]!.id);
  }

  return linkIds;
}

describeDatabase("canonical installment concurrency", () => {
  it("descarta ABERTO de consulta iniciada antes de um pagamento terminal", async () => {
    await transaction(async (client) => {
      const [paidLink, staleLink] = await setup(client);

      await client.query(
        `update campaign_batch_members
            set processing_status = 'processing',
                claimed_at = now() - interval '2 minutes',
                processing_started_at = now() - interval '2 minutes',
                updated_at = now()
          where id = $1::uuid`,
        [staleLink]
      );

      await client.query(
        `update campaign_batch_members
            set processing_status = 'completed',
                payment_status = 'paid',
                payment_status_source = 'erp_explicit',
                installment_amount_cents = 5000,
                payment_amount_cents = 5000,
                total_pending_amount_cents = 0,
                last_erp_status_at = now(),
                updated_at = now()
          where id = $1::uuid`,
        [paidLink]
      );

      const stillInflight = await client.query<{ processing_status: string }>(
        `select processing_status from campaign_batch_members where id = $1::uuid`,
        [staleLink]
      );
      expect(stillInflight.rows[0]!.processing_status).toBe("processing");

      await client.query(
        `update campaign_batch_members
            set processing_status = 'completed',
                payment_status = 'unpaid',
                payment_status_source = 'erp_open_invoice',
                installment_amount_cents = 5000,
                payment_amount_cents = 0,
                total_pending_amount_cents = 5000,
                last_erp_status_at = now() + interval '1 second',
                updated_at = now()
          where id = $1::uuid`,
        [staleLink]
      );

      const state = await client.query<{ payment_status: string; pending: string }>(
        `select canonical.payment_status,
                canonical.pending_amount_cents::text as pending
           from campaign_batch_members cbm
           join member_target_installments canonical
             on canonical.id = cbm.target_installment_ref_id
          where cbm.id = $1::uuid`,
        [staleLink]
      );
      expect(state.rows[0]).toEqual({ payment_status: "paid", pending: "0" });

      const restored = await client.query<{ payment_status: string; processing_status: string }>(
        `select payment_status, processing_status
           from campaign_batch_members
          where id = $1::uuid`,
        [staleLink]
      );
      expect(restored.rows[0]).toEqual({ payment_status: "paid", processing_status: "completed" });
    });
  });

  it("permite que reconciliacao manual iniciada depois corrija paid para unpaid", async () => {
    await transaction(async (client) => {
      const [firstLink, manualLink] = await setup(client);

      await client.query(
        `update campaign_batch_members
            set processing_status = 'completed',
                payment_status = 'paid',
                payment_status_source = 'erp_explicit',
                installment_amount_cents = 5000,
                payment_amount_cents = 5000,
                total_pending_amount_cents = 0,
                last_erp_status_at = now(),
                updated_at = now()
          where id = $1::uuid`,
        [firstLink]
      );

      await client.query(
        `update campaign_batch_members
            set processing_status = 'processing',
                claimed_at = now() + interval '1 second',
                processing_started_at = now() + interval '1 second',
                next_check_at = now(),
                updated_at = now()
          where id = $1::uuid`,
        [manualLink]
      );

      await client.query(
        `update campaign_batch_members
            set processing_status = 'completed',
                payment_status = 'unpaid',
                payment_status_source = 'erp_open_invoice',
                installment_amount_cents = 5000,
                payment_amount_cents = 0,
                total_pending_amount_cents = 5000,
                last_erp_status_at = now() + interval '2 seconds',
                updated_at = now()
          where id = $1::uuid`,
        [manualLink]
      );

      const states = await client.query<{ payment_status: string; pending: string }>(
        `select payment_status, total_pending_amount_cents::text as pending
           from campaign_batch_members
          where id = any($1::uuid[])
          order by id`,
        [[firstLink, manualLink]]
      );

      expect(states.rows).toHaveLength(2);
      for (const row of states.rows) {
        expect(row).toEqual({ payment_status: "unpaid", pending: "5000" });
      }
    });
  });
});
