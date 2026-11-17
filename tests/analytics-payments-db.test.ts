import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { ANALYTICS_BASE_SQL, analyticsSqlArgs, readAnalyticsFilters } from "@/lib/analytics-payments";
import { DASHBOARD_PAID_VALUE_DETAILS_SQL } from "@/lib/dashboard-paid-value-details";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

async function withRollback(run: (client: PoolClient) => Promise<void>) {
  const pool = new Pool({
    host: process.env.DATABASE_HOST ?? "127.0.0.1",
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: process.env.DATABASE_NAME ?? "odontoart_pix_ci",
    user: process.env.DATABASE_USER ?? "postgres",
    password: process.env.DATABASE_PASSWORD ?? "postgres",
    max: 1
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await run(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function campaign(client: PoolClient) {
  const r = await client.query<{ id: string }>(
    "insert into campaigns(name) values ($1) returning id", ["analytics-" + randomUUID()]);
  return r.rows[0]!.id;
}
async function batch(client: PoolClient, campaignId: string) {
  const r = await client.query<{ id: string }>(
    "insert into campaign_batches(campaign_id,name) values ($1::uuid,$2) returning id",
    [campaignId, "analytics-" + randomUUID()]);
  return r.rows[0]!.id;
}
async function member(client: PoolClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const r = await client.query<{ id: string }>(
    "insert into members(cpf,cpf_hash,external_user_code,name) values ($1,$2,$3,$4) returning id",
    [suffix.slice(0,11), "analytics-" + suffix, suffix.slice(0,9), "Associado Exemplo"]);
  return r.rows[0]!.id;
}
async function link(client: PoolClient, c: string, b: string, m: string, code: string) {
  const r = await client.query<{ target_installment_ref_id: string }>(
    "insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id) values ($1::uuid,$2::uuid,$3::uuid,$4) returning target_installment_ref_id",
    [c,b,m,code]);
  return r.rows[0]!.target_installment_ref_id;
}

function args(batches: string[], date = "2026-11-17") {
  return analyticsSqlArgs(readAnalyticsFilters({
    from: date, to: date, batch: batches
  }));
}

describeDatabase("Visão Analítica: conciliação e horários (PostgreSQL rollback)", () => {
  it("não duplica parcela de dois lotes e mantém a janela da mudança de estado", async () => {
    await withRollback(async (client) => {
      const c = await campaign(client);
      const b1 = await batch(client, c);
      const b2 = await batch(client, c);
      const m = await member(client);
      const target = await link(client, c, b1, m, "analytics-001");
      expect(await link(client, c, b2, m, "analytics-001")).toBe(target);
      await client.query(
        `update member_target_installments
          set payment_status = 'unpaid', financial_observed_at = '2026-11-17 10:01:00-03'
          where id = $1::uuid`, [target]);
      await client.query(
        `update member_target_installments
          set payment_status = 'paid', financial_observed_at = '2026-11-17 10:03:00-03',
              payment_date_text = '17/11/2026', due_date_text = '16/11/2026',
              paid_amount_cents = 12500, amount_cents = 12500
          where id = $1::uuid`, [target]);
      const query = ANALYTICS_BASE_SQL + `
        select count(*)::int as count, sum(paid_amount_cents)::bigint as cents,
               min(hour_bucket) as hour, min(delay_days)::int as days
          from filtered`;
      const r = await client.query<{ count: number; cents: string; hour: string; days: number }>(
        query, args([b1, b2]));
      expect(r.rows[0]!.count).toBe(1);
      expect(Number(r.rows[0]!.cents)).toBe(12500);
      expect(r.rows[0]!.hour).toBe("10-12");
      expect(r.rows[0]!.days).toBe(1);
      const dashboard = await client.query<{ installmentCount: number; memberCount: number }>(
        DASHBOARD_PAID_VALUE_DETAILS_SQL, [[], [b1, b2]]);
      expect(dashboard.rows[0]!.installmentCount).toBe(1);
      expect(dashboard.rows[0]!.memberCount).toBe(1);
    });
  });

  it("indica indisponível quando a primeira leitura já é paga", async () => {
    await withRollback(async (client) => {
      const c = await campaign(client), b = await batch(client, c), m = await member(client);
      const target = await link(client, c, b, m, "analytics-first-read");
      await client.query(
        `update member_target_installments
            set payment_status = 'paid', paid_amount_cents = 7500,
                payment_date_text = '17/11/2026', due_date_text = '17/11/2026',
                financial_observed_at = '2026-11-17 14:25:00-03'
          where id = $1::uuid`, [target]);
      const r = await client.query<{ hour: string }>(
        ANALYTICS_BASE_SQL + "select hour_bucket as hour from filtered", args([b]));
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.hour).toBe("unavailable");
    });
  });
});
