import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { DASHBOARD_PAID_VALUE_DETAILS_SQL } from "@/lib/dashboard-paid-value-details";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

function createPool() {
  return new Pool({
    host: process.env.DATABASE_HOST ?? "127.0.0.1",
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: process.env.DATABASE_NAME ?? "odontoart_pix_ci",
    user: process.env.DATABASE_USER ?? "postgres",
    password: process.env.DATABASE_PASSWORD ?? "postgres",
    max: 1
  });
}

async function withRollback(run: (client: PoolClient) => Promise<void>) {
  const pool = createPool();
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
  const result = await client.query<{ id: string }>(
    "insert into campaigns(name) values ($1) returning id", ["paid-details-" + randomUUID()]
  );
  return result.rows[0]!.id;
}

async function batch(client: PoolClient, campaignId: string) {
  const result = await client.query<{ id: string }>(
    "insert into campaign_batches(campaign_id, name) values ($1::uuid, $2) returning id",
    [campaignId, "paid-details-" + randomUUID()]
  );
  return result.rows[0]!.id;
}

async function member(client: PoolClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const result = await client.query<{ id: string }>(
    "insert into members(cpf, cpf_hash, external_user_code) values ($1, $2, $3) returning id",
    [suffix.slice(0, 11), "paid-details-" + suffix, suffix.slice(0, 9)]
  );
  return result.rows[0]!.id;
}

async function link(client: PoolClient, campaignId: string, batchId: string, memberId: string, code: string) {
  const result = await client.query<{ target_installment_ref_id: string }>(
    `insert into campaign_batch_members(campaign_id, batch_id, member_id, target_installment_id)
     values ($1::uuid, $2::uuid, $3::uuid, $4)
     returning target_installment_ref_id`,
    [campaignId, batchId, memberId, code]
  );
  return result.rows[0]!.target_installment_ref_id;
}

async function counts(client: PoolClient, campaignIds: string[] = [], batchIds: string[] = []) {
  const result = await client.query<{ installmentCount: number; memberCount: number }>(
    DASHBOARD_PAID_VALUE_DETAILS_SQL, [campaignIds, batchIds]
  );
  return result.rows[0]!;
}

describeDatabase("Detalhes do Valor pago: parcela canonica e filtros (PostgreSQL rollback)", () => {
  it("nao duplica a parcela presente em mais de um lote e contabiliza associado uma vez", async () => {
    await withRollback(async (client) => {
      const campaignA = await campaign(client);
      const campaignB = await campaign(client);
      const lotA = await batch(client, campaignA);
      const lotB = await batch(client, campaignA);
      const lotC = await batch(client, campaignB);
      const memberA = await member(client);
      const memberB = await member(client);

      const shared = await link(client, campaignA, lotA, memberA, "123456");
      expect(await link(client, campaignA, lotB, memberA, "123456")).toBe(shared);
      const second = await link(client, campaignA, lotB, memberA, "222222");
      const other = await link(client, campaignB, lotC, memberB, "123456");
      const unpaid = await link(client, campaignA, lotA, memberB, "555555");
      const agreed = await link(client, campaignB, lotC, memberB, "666666");

      await client.query(
        "update member_target_installments set payment_status = 'paid' where id = any($1::uuid[])",
        [[shared, second, other]]
      );
      await client.query(
        "update member_target_installments set payment_status = 'unpaid' where id = $1::uuid",
        [unpaid]
      );
      await client.query(
        "update member_target_installments set payment_status = 'agreed' where id = $1::uuid",
        [agreed]
      );

      expect(await counts(client)).toEqual({ installmentCount: 3, memberCount: 2 });
      expect(await counts(client, [], [lotA])).toEqual({ installmentCount: 1, memberCount: 1 });
      expect(await counts(client, [], [lotB])).toEqual({ installmentCount: 2, memberCount: 1 });
      expect(await counts(client, [], [lotA, lotB])).toEqual({ installmentCount: 2, memberCount: 1 });
      expect(await counts(client, [], [lotC])).toEqual({ installmentCount: 1, memberCount: 1 });
      expect(await counts(client, [campaignA])).toEqual({ installmentCount: 2, memberCount: 1 });
      expect(await counts(client, [campaignB])).toEqual({ installmentCount: 1, memberCount: 1 });
      expect(await counts(client, [campaignA], [lotB])).toEqual({ installmentCount: 2, memberCount: 1 });
      expect(await counts(client, [campaignB], [lotB])).toEqual({ installmentCount: 0, memberCount: 0 });
    });
  });
});
