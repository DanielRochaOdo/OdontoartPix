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

async function createScenario(client: PoolClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const campaign = await client.query<{ id: string }>(
    `insert into campaigns(name, status) values ($1, 'rascunho') returning id`,
    [`Canonical ${suffix}`]
  );
  const campaignId = campaign.rows[0]!.id;

  const batches = await client.query<{ id: string; name: string }>(
    `insert into campaign_batches(campaign_id, name, status)
     values ($1::uuid, $2, 'aguardando'),
            ($1::uuid, $3, 'aguardando'),
            ($1::uuid, $4, 'aguardando')
     returning id, name`,
    [campaignId, `Robo ${suffix}`, `Pix ${suffix}`, `Novo ${suffix}`]
  );

  const member = await client.query<{ id: string }>(
    `insert into members(cpf, cpf_hash, name, external_user_code)
     values ($1, $2, $3, $4)
     returning id`,
    [suffix.slice(0, 11), `canonical-${suffix}`, `Associado ${suffix.slice(0, 6)}`, suffix.slice(0, 9)]
  );

  return {
    campaignId,
    batchIds: batches.rows.map((row) => row.id),
    memberId: member.rows[0]!.id
  };
}

describeDatabase("canonical installment database invariant", () => {
  it("compartilha uma parcela entre lotes sem multiplicar a identidade financeira", async () => {
    await withIsolatedTransaction(async (client) => {
      const { campaignId, batchIds, memberId } = await createScenario(client);
      const installmentCode = "123";

      const first = await client.query<{ id: string; target_installment_ref_id: string }>(
        `insert into campaign_batch_members(
           campaign_id, batch_id, member_id, target_installment_id,
           installment_amount_cents, processing_status
         ) values ($1::uuid, $2::uuid, $3::uuid, $4, 5000, 'pending')
         returning id, target_installment_ref_id`,
        [campaignId, batchIds[0], memberId, installmentCode]
      );
      const second = await client.query<{ id: string; target_installment_ref_id: string }>(
        `insert into campaign_batch_members(
           campaign_id, batch_id, member_id, target_installment_id,
           installment_amount_cents, processing_status
         ) values ($1::uuid, $2::uuid, $3::uuid, $4, 5000, 'pending')
         returning id, target_installment_ref_id`,
        [campaignId, batchIds[1], memberId, installmentCode]
      );

      expect(second.rows[0]!.target_installment_ref_id).toBe(first.rows[0]!.target_installment_ref_id);

      const canonical = await client.query<{
        count: string;
        amount_cents: string;
      }>(
        `select count(*)::text as count,
                max(amount_cents)::text as amount_cents
           from member_target_installments
          where member_id = $1::uuid
            and external_installment_code = $2`,
        [memberId, installmentCode]
      );
      expect(canonical.rows[0]).toEqual({ count: "1", amount_cents: "5000" });
    });
  });

  it("propaga pago e saldo para todos os lotes e novos vinculos", async () => {
    await withIsolatedTransaction(async (client) => {
      const { campaignId, batchIds, memberId } = await createScenario(client);
      const installmentCode = "456";

      const links: string[] = [];
      for (const batchId of batchIds.slice(0, 2)) {
        const inserted = await client.query<{ id: string }>(
          `insert into campaign_batch_members(
             campaign_id, batch_id, member_id, target_installment_id,
             installment_amount_cents, processing_status
           ) values ($1::uuid, $2::uuid, $3::uuid, $4, 5000, 'pending')
           returning id`,
          [campaignId, batchId, memberId, installmentCode]
        );
        links.push(inserted.rows[0]!.id);
      }

      await client.query(
        `insert into member_installments(
           campaign_batch_member_id, cod_parcela, payment_description,
           paid_amount_cents, base_amount_cents, final_amount_cents
         ) values ($1::uuid, $2, 'PIX', 5000, 5000, 5000)`,
        [links[0], installmentCode]
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
        [links[0]]
      );

      const siblings = await client.query<{
        id: string;
        processing_status: string;
        payment_status: string;
        installment_amount_cents: string;
        total_pending_amount_cents: string;
      }>(
        `select id,
                processing_status,
                payment_status,
                installment_amount_cents::text,
                total_pending_amount_cents::text
           from campaign_batch_members
          where id = any($1::uuid[])
          order by id`,
        [links]
      );

      for (const row of siblings.rows) {
        expect(row.processing_status).toBe("completed");
        expect(row.payment_status).toBe("paid");
        expect(row.installment_amount_cents).toBe("5000");
        expect(row.total_pending_amount_cents).toBe("0");
      }

      const third = await client.query<{
        processing_status: string;
        payment_status: string;
        installment_amount_cents: string;
        total_pending_amount_cents: string;
      }>(
        `insert into campaign_batch_members(
           campaign_id, batch_id, member_id, target_installment_id,
           installment_amount_cents, processing_status
         ) values ($1::uuid, $2::uuid, $3::uuid, $4, 99999, 'pending')
         returning processing_status,
                   payment_status,
                   installment_amount_cents::text,
                   total_pending_amount_cents::text`,
        [campaignId, batchIds[2], memberId, installmentCode]
      );

      expect(third.rows[0]).toEqual({
        processing_status: "completed",
        payment_status: "paid",
        installment_amount_cents: "5000",
        total_pending_amount_cents: "0"
      });
    });
  });

  it("preserva pagamento parcial no canonico sem liberar processamento automatico", async () => {
    await withIsolatedTransaction(async (client) => {
      const { campaignId, batchIds, memberId } = await createScenario(client);

      const inserted = await client.query<{
        target_installment_ref_id: string;
        total_pending_amount_cents: string;
      }>(
        `insert into campaign_batch_members(
           campaign_id, batch_id, member_id, target_installment_id,
           processing_status, payment_status, payment_status_source,
           installment_amount_cents, payment_amount_cents, total_pending_amount_cents
         ) values (
           $1::uuid, $2::uuid, $3::uuid, '789',
           'completed', 'paid', 'erp_explicit', 5000, 3000, 0
         )
         returning target_installment_ref_id, total_pending_amount_cents::text`,
        [campaignId, batchIds[0], memberId]
      );

      expect(inserted.rows[0]!.total_pending_amount_cents).toBe("2000");

      const canonical = await client.query<{
        payment_status: string;
        pending_amount_cents: string;
      }>(
        `select payment_status, pending_amount_cents::text
           from member_target_installments
          where id = $1::uuid`,
        [inserted.rows[0]!.target_installment_ref_id]
      );

      expect(canonical.rows[0]).toEqual({
        payment_status: "paid",
        pending_amount_cents: "2000"
      });
    });
  });
});
