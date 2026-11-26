import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { DASHBOARD_UNIQUE_UNPAID_PROGRESS_SQL } from "@/lib/dashboard-unique-unpaid-progress";

const ORIGINAL_SQL = readFileSync(new URL("./fixtures/dashboard-unique-unpaid-progress-original.sql", import.meta.url), "utf8").trimEnd();

const describeDb = process.env.CI === "true" ? describe.sequential : describe.skip;

function pool() {
  return new Pool({
    host: process.env.DATABASE_HOST ?? "127.0.0.1",
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: process.env.DATABASE_NAME ?? "odontoart_pix_ci",
    user: process.env.DATABASE_USER ?? "postgres",
    password: process.env.DATABASE_PASSWORD ?? "postgres",
    max: 1
  });
}

async function inRollback(run: (client: PoolClient) => Promise<void>) {
  const p = pool();
  const client = await p.connect();
  try {
    await client.query("begin");
    await run(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await p.end();
  }
}

async function createCampaign(client: PoolClient, label: string) {
  const campaign = await client.query<{ id: string }>(
    "insert into campaigns(name) values ($1) returning id",
    [label + "-" + randomUUID()]
  );
  return campaign.rows[0]!.id;
}

async function createBatch(client: PoolClient, campaignId: string) {
  const batch = await client.query<{ id: string }>(
    "insert into campaign_batches(campaign_id, name) values ($1::uuid, $2) returning id",
    [campaignId, "unique-" + randomUUID()]
  );
  return batch.rows[0]!.id;
}

async function createMember(client: PoolClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const member = await client.query<{ id: string }>(
    "insert into members(cpf, cpf_hash, external_user_code) values ($1, $2, $3) returning id",
    [suffix.slice(0, 11), "unique-progress-" + suffix, suffix.slice(0, 9)]
  );
  return member.rows[0]!.id;
}

async function addLink(
  client: PoolClient,
  campaignId: string,
  batchId: string,
  memberId: string,
  code: string
) {
  const inserted = await client.query<{ id: string; target_installment_ref_id: string }>(
    `insert into campaign_batch_members(
       campaign_id, batch_id, member_id, target_installment_id,
       processing_status
     ) values ($1::uuid, $2::uuid, $3::uuid, $4, 'pending')
     returning id, target_installment_ref_id`,
    [campaignId, batchId, memberId, code]
  );
  return inserted.rows[0]!.target_installment_ref_id;
}

async function readCounters(
  client: PoolClient,
  runId: string,
  campaignIds: string[] = [],
  batchIds: string[] = []
) {
  const result = await client.query<{ processed: number; total: number }>(
    DASHBOARD_UNIQUE_UNPAID_PROGRESS_SQL,
    [runId, campaignIds, batchIds]
  );
  const original = await client.query<{ processed: number; total: number }>(
    ORIGINAL_SQL,
    [runId, campaignIds, batchIds]
  );
  expect(result.rows).toEqual(original.rows);
  return result.rows[0]!;
}

describeDb("Dashboard: parcelas unpaid unicas nos filtros (PostgreSQL rollback)", () => {
  it("inclui uma parcela compartilhada em cada lote selecionado, mas apenas uma vez na uniao", async () => {
    await inRollback(async (client) => {
      const campaignA = await createCampaign(client, "Filters A");
      const campaignB = await createCampaign(client, "Filters B");
      const lotA = await createBatch(client, campaignA);
      const lotB = await createBatch(client, campaignA);
      const lotC = await createBatch(client, campaignB);
      const member = await createMember(client);
      const otherMember = await createMember(client);

      // Same physical invoice, in two batches of the same campaign.
      const shared = await addLink(client, campaignA, lotA, member, "123456");
      expect(await addLink(client, campaignA, lotB, member, "123456")).toBe(shared);
      const onlyB = await addLink(client, campaignA, lotB, member, "654321");
      const onlyC = await addLink(client, campaignB, lotC, otherMember, "777777");
      const paid = await addLink(client, campaignA, lotA, member, "999999");

      await client.query(
        "update member_target_installments set payment_status = 'unpaid' where id = any($1::uuid[])",
        [[shared, onlyB, onlyC]]
      );
      await client.query(
        "update member_target_installments set payment_status = 'paid' where id = $1::uuid",
        [paid]
      );

      const sync = await client.query<{ id: string }>(
        `insert into general_sync_runs(
           request_key, status, trigger_source, sync_mode, batch_count, record_count
         ) values ($1, 'completed', 'scheduled', 'scheduled_recheck', 3, 4) returning id`,
        ["unique-progress-" + randomUUID()]
      );
      const runId = sync.rows[0]!.id;
      // A checked installment is credited in lot B even if consulted via A.
      await client.query(
        `insert into general_sync_run_installments(
           run_id, target_installment_ref_id, source_batch_id
         ) values ($1::uuid, $2::uuid, $3::uuid)`,
        [runId, shared, lotA]
      );

      expect(await readCounters(client, runId)).toEqual({ total: 3, processed: 1 });
      expect(await readCounters(client, runId, [], [lotA])).toEqual({ total: 1, processed: 1 });
      expect(await readCounters(client, runId, [], [lotB])).toEqual({ total: 2, processed: 1 });
      expect(await readCounters(client, runId, [], [lotA, lotB])).toEqual({ total: 2, processed: 1 });
      expect(await readCounters(client, runId, [], [lotC])).toEqual({ total: 1, processed: 0 });
      expect(await readCounters(client, runId, [campaignA])).toEqual({ total: 2, processed: 1 });
      expect(await readCounters(client, runId, [campaignB])).toEqual({ total: 1, processed: 0 });
      expect(await readCounters(client, runId, [campaignA], [lotB])).toEqual({ total: 2, processed: 1 });
      expect(await readCounters(client, runId, [campaignB], [lotB])).toEqual({ total: 0, processed: 0 });

      // No new ERP consultation took place in the second run.
      expect(await readCounters(client, randomUUID(), [], [lotB])).toEqual({
        total: 2, processed: 0
      });
    });
  });

  it("preserva status atual, consultas de outro run, filtros e exclusoes logicas", async () => {
    await inRollback(async (client) => {
      const campaignA = await createCampaign(client, "051A A");
      const campaignB = await createCampaign(client, "051A B");
      const lotA = await createBatch(client, campaignA);
      const lotB = await createBatch(client, campaignB);
      const lotC = await createBatch(client, campaignA);
      const member = await createMember(client);
      const shared = await addLink(client, campaignA, lotA, member, "05101");
      expect(await addLink(client, campaignB, lotB, member, "05101")).toBe(shared);
      const pending = await addLink(client, campaignB, lotB, member, "05102");
      const onlyC = await addLink(client, campaignA, lotC, member, "05103");
      const agreed = await addLink(client, campaignB, lotB, member, "05104");
      const excluded = await addLink(client, campaignB, lotB, member, "05105");
      const unknown = await addLink(client, campaignB, lotB, member, "05106");
      await client.query("update member_target_installments set payment_status='unpaid' where id=any($1::uuid[])", [[shared,pending,onlyC]]);
      for (const [id,status] of [[agreed,"agreed"],[excluded,"excluded"],[unknown,null]]) {
        await client.query("update member_target_installments set payment_status=$2 where id=$1", [id,status]);
      }

      async function newRun() {
        const r = await client.query<{ id: string }>(
          "insert into general_sync_runs(request_key,status,trigger_source,sync_mode,batch_count,record_count) values ($1,'completed','scheduled','scheduled_recheck',3,6) returning id",
          ["051a-"+randomUUID()]
        );
        return r.rows[0]!.id;
      }
      const run = await newRun();
      const other = await newRun();
      async function checked(runId: string, targetId: string, batchId: string) {
        await client.query(
          "insert into general_sync_run_installments(run_id,target_installment_ref_id,source_batch_id) values($1,$2,$3)",
          [runId,targetId,batchId]
        );
      }

      expect(await readCounters(client,run,[campaignB],[lotB])).toEqual({total:2,processed:0});
      await checked(other,pending,lotB);
      await checked(run,shared,lotA);
      await checked(run,agreed,lotB);
      await checked(run,excluded,lotB);
      await checked(run,unknown,lotB);
      expect(await readCounters(client,run,[campaignB],[lotB])).toEqual({total:2,processed:1});
      expect(await readCounters(client,run,[campaignA,campaignB,campaignA],[lotB,lotA,lotB])).toEqual({total:2,processed:1});
      expect(await readCounters(client,run,[campaignA],[lotB])).toEqual({total:0,processed:0});
      expect(await readCounters(client,other,[campaignB],[lotB])).toEqual({total:2,processed:1});
      expect(await readCounters(client,run,[],[lotA,lotC])).toEqual({total:2,processed:1});

      // Deleting the consulted source link must not erase membership in another selected lot.
      await client.query("update campaign_batch_members set deleted_at=now() where batch_id=$1 and target_installment_ref_id=$2", [lotA,shared]);
      expect(await readCounters(client,run,[],[lotA])).toEqual({total:0,processed:0});
      expect(await readCounters(client,run,[],[lotB])).toEqual({total:2,processed:1});

      // A checked target becoming paid (even with remaining balance) leaves both counters.
      await client.query("update member_target_installments set payment_status='paid',amount_cents=10000,paid_amount_cents=3000,pending_amount_cents=7000 where id=$1", [shared]);
      expect(await readCounters(client,run,[],[lotB])).toEqual({total:1,processed:0});
      await checked(run,pending,lotB);
      expect(await readCounters(client,run,[],[lotB])).toEqual({total:1,processed:1});
      await client.query("delete from general_sync_run_installments where run_id=$1", [run]);
      expect(await readCounters(client,run,[],[lotB])).toEqual({total:1,processed:0});
      expect(await readCounters(client,other,[],[lotB])).toEqual({total:1,processed:1});

      await client.query("update campaign_batches set deleted_at=now() where id=$1",[lotC]);
      expect(await readCounters(client,run,[],[lotC])).toEqual({total:0,processed:0});
      await client.query("update campaigns set deleted_at=now() where id=$1",[campaignB]);
      expect(await readCounters(client,other,[campaignB],[])).toEqual({total:0,processed:0});
    });
  });
});
