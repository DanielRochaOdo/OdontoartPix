import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { getAssociadosCardPage } from "@/lib/associados-paginated";

const { queryInTransaction } = vi.hoisted(() => ({ queryInTransaction: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ dbQuery: queryInTransaction }));

const database = process.env.CI === "true" ? describe.sequential : describe.skip;

async function insertId(client: PoolClient, sql: string, args: unknown[]) {
  const result = await client.query<{ id: string }>(sql, args);
  return result.rows[0]!.id;
}

database("Associados: pagina e totais canonicos em uma instantanea SQL", () => {
  it("nao duplica parcela entre lotes, aplica filtros antes da deduplicacao e mantem totais em paginas vazias", async () => {
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
      const c1 = await insertId(client, "insert into campaigns(name) values ($1) returning id", ["associados-page-a-" + randomUUID()]);
      const c2 = await insertId(client, "insert into campaigns(name) values ($1) returning id", ["associados-page-b-" + randomUUID()]);
      const b1 = await insertId(client, "insert into campaign_batches(campaign_id,name) values ($1::uuid,$2) returning id", [c1, "Lote, com virgula"]);
      const b2 = await insertId(client, "insert into campaign_batches(campaign_id,name) values ($1::uuid,$2) returning id", [c2, "Lote, com virgula"]);
      const suffix = randomUUID().replaceAll("-", "");
      const memberId = await insertId(client,
        "insert into members(cpf,cpf_hash,external_user_code,name) values ($1,$2,$3,$4) returning id",
        [suffix.slice(0,11), "page-" + suffix, suffix.slice(0,9), "Associado Teste"]);
      const codePaid = "paid-" + randomUUID().slice(0,8);
      const codeUnpaid = "unpaid-" + randomUUID().slice(0,8);
      const link = async (campaignId: string, batchId: string, code: string) => {
        const result = await client.query<{ target_installment_ref_id: string }>(
          "insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id) values ($1::uuid,$2::uuid,$3::uuid,$4) returning target_installment_ref_id",
          [campaignId,batchId,memberId,code]);
        return result.rows[0]!.target_installment_ref_id;
      };
      const canonicalPaid = await link(c1,b1,codePaid);
      expect(await link(c2,b2,codePaid)).toBe(canonicalPaid);
      const canonicalUnpaid = await link(c2,b2,codeUnpaid);
      await client.query(
        "update member_target_installments set payment_status='paid', amount_cents=1500, paid_amount_cents=1500, pending_amount_cents=0 where id=$1::uuid",
        [canonicalPaid]);
      await client.query(
        "update member_target_installments set payment_status='unpaid', amount_cents=2500, paid_amount_cents=0, pending_amount_cents=2500 where id=$1::uuid",
        [canonicalUnpaid]);

      const all = await getAssociadosCardPage();
      expect(all.filteredCount).toBe(2);
      expect(all.rows).toHaveLength(2);
      expect(all.financialSummary).toEqual({
        totalAmountCents: 4000, paidAmountCents: 1500, pendingAmountCents: 2500
      });
      expect(all.totalCount).toBe(2);

      const firstCampaign = await getAssociadosCardPage({ campaign: [c1] });
      expect(firstCampaign.filteredCount).toBe(1);
      expect(firstCampaign.rows).toHaveLength(1);
      expect(firstCampaign.financialSummary.totalAmountCents).toBe(1500);
      const secondCampaign = await getAssociadosCardPage({ campaign: [c2] });
      expect(secondCampaign.filteredCount).toBe(2);

      const beyondLastPage = await getAssociadosCardPage({}, 2);
      expect(beyondLastPage.rows).toHaveLength(0);
      expect(beyondLastPage.filteredCount).toBe(2);
      expect(beyondLastPage.financialSummary.totalAmountCents).toBe(4000);
      expect(queryInTransaction).toHaveBeenCalledTimes(8);
    } finally {
      queryInTransaction.mockReset();
      await client.query("rollback").catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});
