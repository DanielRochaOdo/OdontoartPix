import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  return value;
}

function createPool() {
  return new Pool({
    host: requiredEnv("DATABASE_HOST"),
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: requiredEnv("DATABASE_NAME"),
    user: requiredEnv("DATABASE_USER"),
    password: requiredEnv("DATABASE_PASSWORD"),
    max: 1,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.DATABASE_SSL?.toLowerCase() === "true" ? { rejectUnauthorized: false } : false
  });
}

async function withTransaction<T>(task: (client: PoolClient) => Promise<T>) {
  const pool = createPool();
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

async function createCampaign(client: PoolClient, name: string) {
  const result = await client.query<{ id: string }>(
    `insert into campaigns(name, status) values ($1, 'rascunho') returning id`,
    [name]
  );
  return result.rows[0]!.id;
}

describeDatabase("campaign batch active name guard", () => {
  it("bloqueia nomes equivalentes dentro da mesma campanha", async () => {
    await withTransaction(async (client) => {
      const suffix = randomUUID();
      const campaignId = await createCampaign(client, `Campaign ${suffix}`);
      await client.query(
        `insert into campaign_batches(campaign_id, name, status) values ($1::uuid, $2, 'aguardando')`,
        [campaignId, "Lote Teste"]
      );

      await expect(
        client.query(
          `insert into campaign_batches(campaign_id, name, status) values ($1::uuid, $2, 'aguardando')`,
          [campaignId, "  lote teste  "]
        )
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "campaign_batches_active_name_guard"
      });
    });
  });

  it("permite o mesmo nome em campanhas diferentes", async () => {
    await withTransaction(async (client) => {
      const suffix = randomUUID();
      const firstCampaignId = await createCampaign(client, `Campaign A ${suffix}`);
      const secondCampaignId = await createCampaign(client, `Campaign B ${suffix}`);

      await client.query(
        `insert into campaign_batches(campaign_id, name, status) values ($1::uuid, 'Mesmo nome', 'aguardando')`,
        [firstCampaignId]
      );
      const second = await client.query<{ id: string }>(
        `insert into campaign_batches(campaign_id, name, status) values ($1::uuid, 'Mesmo nome', 'aguardando') returning id`,
        [secondCampaignId]
      );

      expect(second.rows).toHaveLength(1);
    });
  });
});
