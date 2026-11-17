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

  it("estima deteccao do ERP quando a primeira leitura ja retorna paga no dia", async () => {
    await withRollback(async (client) => {
      const c = await campaign(client), b = await batch(client, c), m = await member(client);
      const target = await link(client, c, b, m, "analytics-first-read");
      await client.query(
        `update member_target_installments
            set payment_status = 'paid', paid_amount_cents = 7500, amount_cents = 7500,
                payment_date_text = '17/11/2026', due_date_text = '17/11/2026',
                last_erp_status_at = '2026-11-17 14:25:00-03',
                financial_observed_at = '2026-11-17 14:24:00-03'
          where id = $1::uuid`, [target]);
      const r = await client.query<{ hour: string; source: string; estimated: string | null }>(
        ANALYTICS_BASE_SQL +
        'select hour_bucket as hour, hour_source as source, estimated_hour as estimated from filtered',
        args([b]));
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toEqual({ hour: "14-16", source: "erp-detection", estimated: "14:25" });
    });
  });

  it("mantem indisponivel se a ultima consulta ERP for em dia posterior ao pagamento", async () => {
    await withRollback(async (client) => {
      const c = await campaign(client), b = await batch(client, c), m = await member(client);
      const target = await link(client, c, b, m, "analytics-next-day");
      await client.query(
        `update member_target_installments
            set payment_status = 'paid', paid_amount_cents = 7500,
                payment_date_text = '17/11/2026', due_date_text = '17/11/2026',
                last_erp_status_at = '2026-11-18 00:05:00-03',
                financial_observed_at = '2026-11-18 00:04:00-03'
          where id = $1::uuid`, [target]);
      const r = await client.query<{ hour: string; source: string }>(
        ANALYTICS_BASE_SQL + 'select hour_bucket as hour, hour_source as source from filtered',
        args([b]));
      expect(r.rows).toEqual([{ hour: "unavailable", source: "unavailable" }]);
    });
  });

  it("nao usa updated_at nem snapshots como hora quando nao ha confirmacao do ERP", async () => {
    await withRollback(async (client) => {
      const c = await campaign(client), b = await batch(client, c), m = await member(client);
      const code = "analytics-no-erp";
      const target = await link(client, c, b, m, code);
      const linkRow = await client.query<{ id: string }>(
        'select id from campaign_batch_members where target_installment_ref_id = $1::uuid',
        [target]);
      await client.query(
        `insert into member_installments (
             campaign_batch_member_id, cod_parcela, base_amount_cents, payment_description,
             payment_date_text, created_at
           ) values ($1::uuid, $2, 7500, 'PIX', '17/11/2026', '2026-11-17 10:20:00-03')`,
        [linkRow.rows[0]!.id, code]);
      await client.query(
        `update member_target_installments
            set payment_status = 'paid', paid_amount_cents = 7500,
                payment_date_text = '17/11/2026', due_date_text = '17/11/2026',
                last_erp_status_at = null, financial_observed_at = '2026-11-17 10:21:00-03',
                updated_at = '2026-11-17 10:21:00-03'
          where id = $1::uuid`, [target]);
      const r = await client.query<{ hour: string; source: string }>(
        ANALYTICS_BASE_SQL + 'select hour_bucket as hour, hour_source as source from filtered',
        args([b]));
      expect(r.rows).toEqual([{ hour: "unavailable", source: "unavailable" }]);
    });
  });

  it("prefere uma janela comprovada ao horario mais recente do ERP", async () => {
    await withRollback(async (client) => {
      const c = await campaign(client), b = await batch(client, c), m = await member(client);
      const target = await link(client, c, b, m, "analytics-window-first");
      await client.query(
        `update member_target_installments
          set payment_status = 'unpaid',
              financial_observed_at = '2026-11-17 10:01:00-03'
          where id = $1::uuid`, [target]);
      await client.query(
        `update member_target_installments
          set payment_status = 'paid',
              payment_date_text = '17/11/2026', paid_amount_cents = 7500,
              financial_observed_at = '2026-11-17 10:03:00-03',
              last_erp_status_at = '2026-11-17 15:30:00-03'
          where id = $1::uuid`, [target]);
      const r = await client.query<{ hour: string; source: string; estimated: string | null }>(
        ANALYTICS_BASE_SQL +
        'select hour_bucket as hour, hour_source as source, estimated_hour as estimated from filtered',
        args([b]));
      expect(r.rows).toEqual([{
        hour: "10-12", source: "observed-window", estimated: "10:01–10:03"
      }]);
    });
  });

  it("nao usa timestamp ERP quando financial_observed_at diverge da data paga", async () => {
    await withRollback(async (client) => {
      const c = await campaign(client), b = await batch(client, c), m = await member(client);
      const target = await link(client, c, b, m, "analytics-financial-mismatch");
      await client.query(
        `update member_target_installments
            set payment_status = 'paid', paid_amount_cents = 7500,
                payment_date_text = '17/11/2026',
                last_erp_status_at = '2026-11-17 14:25:00-03',
                financial_observed_at = '2026-11-18 00:05:00-03'
          where id = $1::uuid`, [target]);
      const r = await client.query<{ hour: string }>(
        ANALYTICS_BASE_SQL + 'select hour_bucket as hour from filtered',
        args([b]));
      expect(r.rows).toEqual([{ hour: "unavailable" }]);
    });
  });

  it("registra mudanca de pagamento mesmo com usuario de aplicativo sem INSERT na tabela de horarios", async () => {
    await withRollback(async (client) => {
      const c = await campaign(client), b = await batch(client, c), m = await member(client);
      const target = await link(client, c, b, m, "analytics-runtime-role");
      const role = "analytics_role_" + randomUUID().replaceAll("-", "").slice(0, 15);
      await client.query(`create role "${role}" nologin`);
      await client.query(`grant usage on schema public to "${role}"`);
      await client.query(`grant select, update on member_target_installments to "${role}"`);
      await client.query(`grant select on payment_hour_observations to "${role}"`);
      await client.query(`set local role "${role}"`);
      const privileges = await client.query<{ allowed: boolean }>(
        "select has_table_privilege(current_user, 'payment_hour_observations', 'INSERT') as allowed"
      );
      expect(privileges.rows[0]!.allowed).toBe(false);
      const executeAccess = await client.query<{ allowed: boolean }>(
        "select has_function_privilege(current_user, 'public.track_canonical_payment_hour_v1()', 'EXECUTE') as allowed"
      );
      expect(executeAccess.rows[0]!.allowed).toBe(false);

      await client.query(
        "update member_target_installments set payment_status = 'unpaid', financial_observed_at = $2::timestamptz where id = $1::uuid",
        [target, "2026-11-17 09:59:00-03"]
      );
      await client.query(
        "update member_target_installments set payment_status = 'paid', financial_observed_at = $2::timestamptz where id = $1::uuid",
        [target, "2026-11-17 10:01:00-03"]
      );
      const rows = await client.query<{ last_unpaid_at: Date | null; first_paid_at: Date | null }>(
        "select last_unpaid_at, first_paid_at from payment_hour_observations where target_installment_id = $1::uuid",
        [target]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.last_unpaid_at).not.toBeNull();
      expect(rows.rows[0]!.first_paid_at).not.toBeNull();
      await client.query("reset role");
    });
  });

});
