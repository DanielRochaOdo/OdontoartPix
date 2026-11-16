import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { PAYMENT_SOURCE_SQL, paymentFilterSearch, readPaymentFilters } from "@/lib/payment-punctuality";

const describeDb = process.env.CI === "true" ? describe.sequential : describe.skip;

const poolFactory = () => new Pool({
  host: process.env.DATABASE_HOST ?? "127.0.0.1",
  port: Number(process.env.DATABASE_PORT ?? "5432"),
  database: process.env.DATABASE_NAME ?? "odontoart_pix_ci",
  user: process.env.DATABASE_USER ?? "postgres",
  password: process.env.DATABASE_PASSWORD ?? "postgres",
  max: 1
});

async function withRollback(action: (client: PoolClient) => Promise<void>) {
  const pool = poolFactory();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await action(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function createCampaign(client: PoolClient, name: string) {
  const result = await client.query<{ id: string }>(
    "insert into campaigns(name) values ($1) returning id", [name]
  );
  return result.rows[0]!.id;
}

async function createBatch(client: PoolClient, campaignId: string, name: string) {
  const result = await client.query<{ id: string }>(
    "insert into campaign_batches(campaign_id, name) values ($1::uuid, $2) returning id",
    [campaignId, name]
  );
  return result.rows[0]!.id;
}

async function createMember(client: PoolClient) {
  const key = randomUUID().replaceAll("-", "");
  const result = await client.query<{ id: string; external_user_code: string }>(
    `insert into members(cpf, cpf_hash, external_user_code, name)
     values ($1, $2, $3, $4) returning id, external_user_code`,
    [key.slice(0, 11), "punct-filters-" + key, key.slice(0, 9), "Pessoa " + key.slice(0, 8)]
  );
  return result.rows[0]!;
}

async function link(
  client: PoolClient, campaignId: string, batchId: string, memberId: string,
  code: string, status = "completed"
) {
  const result = await client.query<{ target_installment_ref_id: string }>(
    `insert into campaign_batch_members(
       campaign_id, batch_id, member_id, target_installment_id, processing_status
     ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5)
     returning target_installment_ref_id`,
    [campaignId, batchId, memberId, code, status]
  );
  return result.rows[0]!.target_installment_ref_id;
}

async function eligibility(
  client: PoolClient,
  overrides: Record<string, string | string[]> = {},
  extraScopes: string[] = ["paid", "late", "open"]
) {
  const filters = readPaymentFilters(overrides, "2026-11-16");
  const result = await client.query<{ id: string; payment_status: string }>(
    PAYMENT_SOURCE_SQL + " select id, payment_status from eligible order by id",
    [
      filters.from || null, filters.to || null,
      filters.plans.length ? filters.plans : null,
      filters.dues.length ? filters.dues : null,
      filters.methods.length ? filters.methods : null,
      filters.asOf, extraScopes, filters.dateBasis, JSON.stringify(filters.associated)
    ]
  );
  return result.rows;
}

describeDb("Pontualidade: Associados e filtros de lotes compartilhados", () => {
  it("mantem a parcela unica no filtro A e B, mas nao multiplica na uniao", async () => {
    await withRollback(async (client) => {
      const suffix = randomUUID().slice(0, 8);
      const ca = await createCampaign(client, "PONTUAL A " + suffix);
      const cb = await createCampaign(client, "PONTUAL B " + suffix);
      const a = await createBatch(client, ca, "A " + suffix);
      const b = await createBatch(client, ca, "B, com virgula " + suffix);
      const c = await createBatch(client, cb, "C " + suffix);
      const firstMember = await createMember(client);
      const secondMember = await createMember(client);
      const shared = await link(client, ca, a, firstMember.id, "123456");
      expect(await link(client, ca, b, firstMember.id, "123456")).toBe(shared);
      expect(await link(client, cb, c, firstMember.id, "123456", "pending")).toBe(shared);
      const second = await link(client, ca, a, secondMember.id, "222222");
      const open = await link(client, cb, c, secondMember.id, "333333");

      await client.query(
        `update member_target_installments set
          installment_type = 'clinico', due_date_text = '10/11/2026',
          payment_date_text = '12/11/2026', payment_status = 'paid',
          payment_description = 'PIX', paid_amount_cents = 10000,
          pending_amount_cents = 0
          where id = any($1::uuid[])`,
        [[shared, second]]
      );
      await client.query(
        `update member_target_installments set
          installment_type = 'orto', due_date_text = '10/11/2026',
          payment_status = 'unpaid', payment_description = 'ABERTO',
          paid_amount_cents = null, pending_amount_cents = 15000
         where id = $1::uuid`, [open]
      );
      const select = async (params: Record<string, string | string[]>, scopes = ["paid", "late", "open"]) =>
        (await eligibility(client, params, scopes)).map((row) => row.id);

      expect(await select({ campaign: [ca], batch: [a] })).toEqual([second, shared].sort());
      expect(await select({ campaign: [ca], batch: [b] })).toEqual([shared]);
      expect(await select({ campaign: [ca], batch: [a, b] })).toEqual([second, shared].sort());
      expect(await select({ campaign: [cb], batch: [c] })).toEqual([shared, open].sort());
      expect(await select({ campaign: [ca], batch: [c] })).toEqual([]);
      expect(await select({ campaign: [cb], batch: [c], status: ["pending"] })).toEqual([shared, open].sort());
      expect(await select({ campaign: [cb], batch: [c], status: ["completed"] })).toEqual([]);
      expect(await select({ campaign: [ca], batch: [a], payment: ["paid"] })).toEqual([second, shared].sort());
      expect(await select({ campaign: [cb], batch: [c], payment: ["unpaid"] })).toEqual([open]);
      expect(await select({ campaign: [ca], batch: [a], receipt: ["PIX"] })).toEqual([second, shared].sort());
      expect(await select({ campaign: [ca], batch: [a], installmentType: ["Orto"] })).toEqual([]);
      expect(await select({ campaign: [ca], batch: [a], code: firstMember.external_user_code })).toEqual([shared]);
      expect(await select({ campaign: [ca], batch: [a], installment: ["123456"] })).toEqual([shared]);
      expect(await select({ campaign: [ca], batch: [a], dueDateFrom: "2026-11-11" })).toEqual([]);
      expect(await select({ campaign: [ca], batch: [a], paymentDateTo: "2026-11-11" })).toEqual([]);
      expect(await select({ campaign: [ca], batch: [a], query: "B, com virgula" })).toEqual([shared]);
      expect(await select({ campaign: [ca], batch: [a], payment: ["paid"] }, ["paid"])).toEqual([]);
      const roundtrip = paymentFilterSearch(readPaymentFilters({
        campaign: [ca], batch: [b], status: ["completed"], dueDateFrom: "2026-11-01"
      }, "2026-11-16"), { tab: "planos" });
      expect(roundtrip).toContain("campaign=" + ca);
      expect(roundtrip).toContain("batch=" + b);
      expect(roundtrip).toContain("status=completed");
      expect(roundtrip).toContain("dueDateFrom=2026-11-01");
    });
  });
});
