import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  ANALYTICS_GLOBAL_CATALOG_SQL,
  getAnalyticsGlobalFilterOptions
} from "@/lib/analytics-global-filter-options";
import { getAssociadosCardFilterOptions, getAssociadosCardFilterOptionsLegacy } from "@/lib/associados-paginated";

// Both readers run on the SAME PostgreSQL transaction: the fixture is visible
// to both, and the rollback leaves no rows or changes behind in the CI database.
const { queryInTransaction } = vi.hoisted(() => ({ queryInTransaction: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({
  dbQuery: queryInTransaction
}));

async function rollback(run: (client: PoolClient) => Promise<void>) {
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
    queryInTransaction.mockImplementation((sql, args) => client.query(sql, args));
    await run(client);
  } finally {
    queryInTransaction.mockReset();
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function insertCampaign(client: PoolClient) {
  const row = await client.query<{ id: string }>(
    "insert into campaigns(name) values ($1) returning id",
    ["facets-" + randomUUID()]);
  return row.rows[0]!.id;
}
async function insertBatch(client: PoolClient, campaignId: string) {
  const row = await client.query<{ id: string }>(
    "insert into campaign_batches(campaign_id, name) values ($1::uuid,$2) returning id",
    [campaignId, "Lote, com vírgula " + randomUUID()]);
  return row.rows[0]!.id;
}
async function insertMember(client: PoolClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const row = await client.query<{ id: string }>(
    "insert into members(cpf,cpf_hash,external_user_code,name) values ($1,$2,$3,$4) returning id",
    [suffix.slice(0, 11), "facets-" + suffix, suffix.slice(0, 9), "Associado Faceta"]);
  return row.rows[0]!.id;
}
async function insertLink(client: PoolClient, campaignId: string, batchId: string, memberId: string, code: string) {
  const row = await client.query<{ id: string; target_installment_ref_id: string }>(
    `insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id)
      values ($1::uuid,$2::uuid,$3::uuid,$4)
      returning id, target_installment_ref_id`,
    [campaignId, batchId, memberId, code]);
  return row.rows[0]!;
}

describe("Visao Analitica: catalogo leve de 6 facetas", () => {
  it("usa somente 1 SQL e nao calcula datas, valores, texto ou representantes", () => {
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).toContain("group by target_installment_ref_id");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).toContain("m.deleted_at is null");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).toContain("l.deleted_at is null");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).toContain("c.deleted_at is null");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).toContain("b.deleted_at is null");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).toContain("bool_or(processing_status = 'error')");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).toContain("select distinct facet, value, label");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).not.toContain("to_date(");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).not.toContain("payment_hour_observations");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).not.toContain("paid_amount_cents");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).not.toContain("member_name");
    expect(ANALYTICS_GLOBAL_CATALOG_SQL).not.toContain("representative_id");
  });
});

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;
describeDatabase("Visao Analitica: paridade de facetas no PostgreSQL (rollback)", () => {
  it("tem exatamente os mesmos itens e ordenacao que o catalogo legado, com multiplos lotes, soft deletes e estados mistos", async () => {
    await rollback(async (client) => {
      const c1 = await insertCampaign(client);
      const c2 = await insertCampaign(client);
      const b1 = await insertBatch(client, c1);
      const b2 = await insertBatch(client, c2);
      const member1 = await insertMember(client);
      const code = "facet-dual-" + randomUUID().slice(0, 7);

      const first = await insertLink(client, c1, b1, member1, code);
      const second = await insertLink(client, c2, b2, member1, code);
      expect(first.target_installment_ref_id).toBe(second.target_installment_ref_id);
      await client.query(
        "update campaign_batch_members set processing_status = 'error' where id = $1::uuid",
        [first.id]);
      await client.query(
        "update campaign_batch_members set processing_status = 'completed' where id = $1::uuid",
        [second.id]);
      await client.query(
        `update member_target_installments
            set payment_status = 'paid', payment_description = 'PIX',
                installment_type = 'clinico', paid_amount_cents = 19500,
                amount_cents = 19500
          where id = $1::uuid`,
        [first.target_installment_ref_id]);

      const member2 = await insertMember(client);
      const agreement = await insertLink(client, c2, b2, member2, "facet-agreement-" + randomUUID().slice(0, 7));
      await client.query(
        `update member_target_installments
            set payment_status = 'agreed', payment_description = 'CARTAO',
                installment_type = 'orto'
          where id = $1::uuid`,
        [agreement.target_installment_ref_id]);

      // A link exists but its member is soft deleted: the catalog must exclude it.
      const deletedMember = await insertMember(client);
      const hidden = await insertLink(client, c1, b1, deletedMember, "facet-hidden-" + randomUUID().slice(0, 7));
      await client.query(
        "update members set deleted_at = now() where id = $1::uuid", [deletedMember]);
      await client.query(
        "update member_target_installments set payment_description = 'SECRET-REMOVED' where id = $1::uuid",
        [hidden.target_installment_ref_id]);

      // Additional links attached to the same canonical, but inactive by soft delete.
      const inactiveCampaign = await insertCampaign(client);
      const inactiveBatch = await insertBatch(client, inactiveCampaign);
      await insertLink(client, inactiveCampaign, inactiveBatch, member1, code);
      await client.query("update campaigns set deleted_at = now() where id = $1::uuid", [inactiveCampaign]);

      const oldBatch = await insertBatch(client, c1);
      await insertLink(client, c1, oldBatch, member1, code);
      await client.query("update campaign_batches set deleted_at = now() where id = $1::uuid", [oldBatch]);

      const legacy = await getAssociadosCardFilterOptionsLegacy({});
      const fast = await getAssociadosCardFilterOptions({});
      const optimized = await getAnalyticsGlobalFilterOptions();
      expect(fast).toEqual(legacy);
      expect(optimized).toEqual(legacy);
      expect(optimized.campaign).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: c1 }),
        expect.objectContaining({ value: c2 })
      ]));
      expect(optimized.batch).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: b1 }),
        expect.objectContaining({ value: b2 })
      ]));
      expect(optimized.campaign.some((item) => item.value === inactiveCampaign)).toBe(false);
      expect(optimized.batch.some((item) => item.value === inactiveBatch || item.value === oldBatch)).toBe(false);
      expect(optimized.status.some((item) => item.value === "error")).toBe(true);
      expect(optimized.receipt.some((item) => item.value === "SECRET-REMOVED")).toBe(false);
      expect(optimized.installmentType).toEqual(expect.arrayContaining([
        { value: "Clínico", label: "Clínico" },
        { value: "Orto", label: "Orto" }
      ]));
      // SQL original = 3 leituras; catálogo leve da página = 1; leitor
      // independente da Visão Analítica = 1. Paridade completa no PostgreSQL.
      expect(queryInTransaction).toHaveBeenCalledTimes(5);
      expect(String(queryInTransaction.mock.calls[0]?.[0])).toContain("cross join lateral (values");
      expect(String(queryInTransaction.mock.calls[3]?.[0])).toContain("values_by_facet");
      expect(String(queryInTransaction.mock.calls[4]?.[0])).toContain("values_by_facet");
    });
  });

  it("compara o catalogo completo sem filtros mesmo que nao haja registros", async () => {
    await rollback(async () => {
      expect(await getAnalyticsGlobalFilterOptions()).toEqual(
        await getAssociadosCardFilterOptionsLegacy({})
      );
      expect(await getAssociadosCardFilterOptions({})).toEqual(
        await getAssociadosCardFilterOptionsLegacy({})
      );
    });
  });
});
