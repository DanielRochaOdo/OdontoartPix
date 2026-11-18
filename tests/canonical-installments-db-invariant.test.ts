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

  it("evita regravar lotes cujos totais calculados ja sao iguais", async () => {
    await withIsolatedTransaction(async (client) => {
      const { campaignId, batchIds, memberId } = await createScenario(client);
      const affectedBatches = batchIds.slice(0, 2);

      for (const batchId of affectedBatches) {
        await client.query(
          `insert into campaign_batch_members(
             campaign_id, batch_id, member_id, target_installment_id,
             installment_amount_cents, processing_status
           ) values ($1::uuid, $2::uuid, $3::uuid, 'RECALC-1', 5000, 'pending')`,
          [campaignId, batchId, memberId]
        );
        await client.query("select recalculate_batch_totals($1::uuid)", [batchId]);
      }

      const snapshot = () =>
        client.query<{
          id: string;
          heap_tuple: string;
          total_records: number;
          total_amount_cents: string;
          status: string;
        }>(
          `select id, ctid::text as heap_tuple,
                  total_records, total_amount_cents::text, status
             from campaign_batches
            where id = any($1::uuid[])
            order by id`,
          [affectedBatches]
        );
      const before = (await snapshot()).rows;
      expect(before).toHaveLength(2);
      for (const row of before) {
        expect(row.total_records).toBe(1);
        expect(row.total_amount_cents).toBe("5000");
        expect(row.status).toBe("aguardando");
      }

      for (const batchId of affectedBatches) {
        await client.query("select recalculate_batch_totals($1::uuid)", [batchId]);
        await client.query("select recalculate_batch_totals($1::uuid)", [batchId]);
      }
      // Every real heap UPDATE changes ctid, even inside the same transaction.
      expect((await snapshot()).rows).toEqual(before);
    });
  });

  it("propaga pagamento parcial entre lotes e mantem no-op idempotente", async () => {
    await withIsolatedTransaction(async (client) => {
      const { campaignId, batchIds, memberId } = await createScenario(client);
      const affectedBatches = batchIds.slice(0, 2);
      const links: string[] = [];

      for (const batchId of affectedBatches) {
        const inserted = await client.query<{ id: string }>(
          `insert into campaign_batch_members(
             campaign_id, batch_id, member_id, target_installment_id,
             installment_amount_cents, processing_status
           ) values ($1::uuid, $2::uuid, $3::uuid, 'RECALC-2', 5000, 'pending')
           returning id`,
          [campaignId, batchId, memberId]
        );
        links.push(inserted.rows[0]!.id);
        await client.query("select recalculate_batch_totals($1::uuid)", [batchId]);
      }

      const before = await client.query<{ id: string; heap_tuple: string }>(
        `select id, ctid::text as heap_tuple from campaign_batches
          where id = any($1::uuid[]) order by id`,
        [affectedBatches]
      );

      await client.query(
        `update campaign_batch_members
            set processing_status = 'completed',
                payment_status = 'paid',
                payment_status_source = 'erp_explicit',
                installment_amount_cents = 5000,
                payment_amount_cents = 3000,
                total_pending_amount_cents = 2000,
                last_erp_status_at = now(),
                updated_at = now()
          where id = $1::uuid`,
        [links[0]]
      );

      const getTotals = () =>
        client.query<{
          id: string;
          heap_tuple: string;
          total_records: number;
          processed_records: number;
          paid_records: number;
          total_amount_cents: string;
          total_pending_amount_cents: string;
          status: string;
        }>(
          `select id, ctid::text as heap_tuple, total_records,
                  processed_records, paid_records, total_amount_cents::text,
                  total_pending_amount_cents::text, status
             from campaign_batches
            where id = any($1::uuid[]) order by id`,
          [affectedBatches]
        );

      const after = (await getTotals()).rows;
      expect(after).toHaveLength(2);
      for (const [index, row] of after.entries()) {
        expect(row.heap_tuple).not.toBe(before.rows[index]!.heap_tuple);
        expect(row.total_records).toBe(1);
        expect(row.processed_records).toBe(1);
        expect(row.paid_records).toBe(1);
        expect(row.total_amount_cents).toBe("5000");
        expect(row.total_pending_amount_cents).toBe("2000");
        expect(row.status).toBe("concluido");
      }

      const siblings = await client.query<{
        payment_status: string;
        total_pending_amount_cents: string;
      }>(
        `select payment_status, total_pending_amount_cents::text
           from campaign_batch_members
          where id = any($1::uuid[])`,
        [links]
      );
      expect(siblings.rows).toHaveLength(2);
      for (const link of siblings.rows) {
        expect(link.payment_status).toBe("paid");
        expect(link.total_pending_amount_cents).toBe("2000");
      }

      for (const batchId of affectedBatches) {
        await client.query("select recalculate_batch_totals($1::uuid)", [batchId]);
      }
      expect((await getTotals()).rows).toEqual(after);
    });
  });
  it("preserva os totais em ambos os caminhos: lote pequeno e lote acima do limite", async () => {
    await withIsolatedTransaction(async (client) => {
      const { campaignId, batchIds, memberId } = await createScenario(client);
      const [largeId, smallId] = batchIds;
      const links: string[] = [];

      for (const batchId of [largeId, smallId]) {
        const row = await client.query<{ id: string; target_installment_ref_id: string }>(
          `insert into campaign_batch_members(
             campaign_id, batch_id, member_id, target_installment_id,
             installment_amount_cents, processing_status
           ) values ($1::uuid, $2::uuid, $3::uuid, 'RECALC-041', 5000, 'pending')
           returning id, target_installment_ref_id`,
          [campaignId, batchId, memberId]
        );
        links.push(row.rows[0]!.id);
      }

      // 2,501 additional links without a canonical target make this batch
      // follow the large-batch branch (> 2,500 active links). The target
      // columns are nullable in the operational schema. Bulk insert remains
      // fully transactionally rolled back after the test.
      await client.query(
        `insert into campaign_batch_members(
           campaign_id, batch_id, member_id, target_installment_id,
           installment_amount_cents, processing_status
         )
         select $1::uuid, $2::uuid, $3::uuid, null, 0, 'pending'
           from generate_series(1, 2501)`,
        [campaignId, largeId, memberId]
      );

      const getTotals = async () => (await client.query<{
        id: string;
        heap_tuple: string;
        total_records: number;
        processed_records: number;
        paid_records: number;
        total_amount_cents: string;
        total_pending_amount_cents: string;
        status: string;
      }>(
        `select id, ctid::text as heap_tuple, total_records,
                processed_records, paid_records, total_amount_cents::text,
                total_pending_amount_cents::text, status
           from campaign_batches
          where id = any($1::uuid[])
          order by id`,
        [[largeId, smallId]]
      )).rows;

      await client.query("select recalculate_batch_totals($1::uuid)", [largeId]);
      await client.query("select recalculate_batch_totals($1::uuid)", [smallId]);

      const initial = await getTotals();
      const byId = (rows: typeof initial, id: string) => rows.find((row) => row.id === id)!;
      expect(byId(initial, largeId)).toMatchObject({
        total_records: 2502,
        processed_records: 0,
        paid_records: 0,
        total_amount_cents: "5000",
        status: "aguardando"
      });
      expect(byId(initial, smallId)).toMatchObject({
        total_records: 1,
        processed_records: 0,
        paid_records: 0,
        total_amount_cents: "5000",
        status: "aguardando"
      });

      // The canonical truth capture propagates a partial paid installment
      // to BOTH batches; neither path may omit the shared occurrence.
      await client.query(
        `update campaign_batch_members
            set processing_status = 'completed',
                payment_status = 'paid',
                payment_status_source = 'erp_explicit',
                installment_amount_cents = 5000,
                payment_amount_cents = 3000,
                total_pending_amount_cents = 2000,
                last_erp_status_at = now(),
                updated_at = now()
          where id = $1::uuid`,
        [links[0]]
      );

      await client.query("select recalculate_batch_totals($1::uuid)", [largeId]);
      await client.query("select recalculate_batch_totals($1::uuid)", [smallId]);

      const paid = await getTotals();
      for (const batchId of [largeId, smallId]) {
        const item = byId(paid, batchId);
        expect(item.processed_records).toBe(1);
        expect(item.paid_records).toBe(1);
        expect(item.total_amount_cents).toBe("5000");
        expect(item.total_pending_amount_cents).toBe("2000");
      }
      expect(byId(paid, largeId).status).toBe("aguardando");
      expect(byId(paid, smallId).status).toBe("concluido");

      const shared = await client.query<{
        payment_status: string;
        total_pending_amount_cents: string;
      }>(
        `select payment_status, total_pending_amount_cents::text
           from campaign_batch_members
          where id = any($1::uuid[])`,
        [links]
      );
      expect(shared.rows).toHaveLength(2);
      for (const row of shared.rows) {
        expect(row.payment_status).toBe("paid");
        expect(row.total_pending_amount_cents).toBe("2000");
      }

      // Repeating a no-op calculation must not rewrite either batch.
      await client.query("select recalculate_batch_totals($1::uuid)", [largeId]);
      await client.query("select recalculate_batch_totals($1::uuid)", [smallId]);
      expect(await getTotals()).toEqual(paid);
    });
  }, 60_000);

});
