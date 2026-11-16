import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { DISPATCH_FILTER_OPTIONS_SQL } from "@/lib/dispatches";

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

async function campaign(client: PoolClient, name: string) {
  const result = await client.query<{ id: string }>(
    "insert into campaigns(name) values ($1) returning id",
    [name]
  );
  return result.rows[0]!.id;
}

async function batch(client: PoolClient, campaignId: string, name: string) {
  const result = await client.query<{ id: string }>(
    "insert into campaign_batches(campaign_id, name) values ($1::uuid, $2) returning id",
    [campaignId, name]
  );
  return result.rows[0]!.id;
}

async function member(client: PoolClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const result = await client.query<{ id: string }>(
    "insert into members(cpf, cpf_hash, external_user_code) values ($1, $2, $3) returning id",
    [suffix.slice(0, 11), "dispatch-options-" + suffix, suffix.slice(0, 9)]
  );
  return result.rows[0]!.id;
}

async function link(
  client: PoolClient,
  campaignId: string,
  batchId: string,
  memberId: string,
  code = "123456"
) {
  const result = await client.query<{ target_installment_ref_id: string }>(
    `insert into campaign_batch_members(
      campaign_id, batch_id, member_id, target_installment_id
    ) values ($1::uuid, $2::uuid, $3::uuid, $4)
    returning target_installment_ref_id`,
    [campaignId, batchId, memberId, code]
  );
  return result.rows[0]!.target_installment_ref_id;
}

type Option = { value: string; label: string };

async function options(client: PoolClient) {
  const params = [
    [], [], [], [], [], [], null, null, null, null, null, null, null,
    "all", "all", null, null, [], false
  ];
  const result = await client.query<{ campaign: Option[]; batch: Option[] }>(
    DISPATCH_FILTER_OPTIONS_SQL,
    params
  );
  return result.rows[0]!;
}

describeDatabase("Disparos: filtros individualizados por campanha e lote", () => {
  it("nao junta campanhas/lotes de uma parcela compartilhada nem divide nomes que possuem virgula", async () => {
    await withRollback(async (client) => {
      const suffix = randomUUID().slice(0, 8);
      const nameA = "IA - AGOSTO_26 " + suffix;
      const nameB = "OP - NOVEMBRO_26 " + suffix;
      const batchNameA = "05.11.2026, DISPARO CLINICO " + suffix;
      const batchNameB = "13.11.2026 " + suffix;
      const batchNameC = "OUTUBRO_26 " + suffix;
      const campaignA = await campaign(client, nameA);
      const campaignB = await campaign(client, nameB);
      const lotA = await batch(client, campaignA, batchNameA);
      const lotB = await batch(client, campaignA, batchNameB);
      const lotC = await batch(client, campaignB, batchNameC);
      const sharedMember = await member(client);

      // Same financial invoice is linked to three batches and two campaigns.
      const shared = await link(client, campaignA, lotA, sharedMember);
      expect(await link(client, campaignA, lotB, sharedMember)).toBe(shared);
      expect(await link(client, campaignB, lotC, sharedMember)).toBe(shared);
      // Duplicate links must not duplicate filter options.
      await link(client, campaignA, lotA, await member(client));

      const result = await options(client);
      const expectedCampaigns = [
        { value: campaignA, label: nameA }, { value: campaignB, label: nameB }
      ];
      const expectedBatches = [
        { value: lotA, label: batchNameA },
        { value: lotB, label: batchNameB },
        { value: lotC, label: batchNameC }
      ];
      for (const item of expectedCampaigns) {
        expect(result.campaign.filter((option) => option.value === item.value))
          .toEqual([item]);
      }
      for (const item of expectedBatches) {
        expect(result.batch.filter((option) => option.value === item.value))
          .toEqual([item]);
      }
      expect(result.campaign.some((option) =>
        option.label.includes(nameA + ", " + nameB)
      )).toBe(false);
      // This comma belongs to the original lot name and must be preserved.
      expect(result.batch.find((option) => option.value === lotA)?.label)
        .toBe(batchNameA);
    });
  });
});
