import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  generalSyncUniqueTargetsEnabled,
  recordSuccessfulGeneralSyncTarget,
  reuseSuccessfulGeneralSyncTargets
} from "@/lib/general-sync-unique-targets";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

function dbPool() {
  return new Pool({
    host: process.env.DATABASE_HOST ?? "127.0.0.1",
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: process.env.DATABASE_NAME ?? "odontoart_pix_ci",
    user: process.env.DATABASE_USER ?? "postgres",
    password: process.env.DATABASE_PASSWORD ?? "postgres",
    max: 1
  });
}

async function rollbackScenario<T>(run: (client: PoolClient) => Promise<T>) {
  const pool = dbPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await run(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function setup(client: PoolClient, count = 4) {
  const suffix = randomUUID().replaceAll("-", "");
  const campaign = await client.query<{ id: string }>(
    "insert into campaigns(name) values ($1) returning id",
    ["Dedup " + suffix]
  );
  const campaignId = campaign.rows[0]!.id;
  const batchIds: string[] = [];
  const links: string[] = [];
  const member = await client.query<{ id: string }>(
    `insert into members(cpf, cpf_hash, external_user_code)
     values ($1, $2, $3) returning id`,
    [suffix.slice(0, 11), "dedup-" + suffix, suffix.slice(0, 9)]
  );

  for (let i = 0; i < count; i++) {
    const batch = await client.query<{ id: string }>(
      `insert into campaign_batches(campaign_id, name) values ($1::uuid, $2) returning id`,
      [campaignId, "Batch " + i + " " + suffix]
    );
    batchIds.push(batch.rows[0]!.id);
    const linked = await client.query<{ id: string }>(
      `insert into campaign_batch_members(
         campaign_id, batch_id, member_id, target_installment_id,
         installment_amount_cents, processing_status
       ) values ($1::uuid, $2::uuid, $3::uuid, '123456', 5000, 'pending')
       returning id`,
      [campaignId, batch.rows[0]!.id, member.rows[0]!.id]
    );
    links.push(linked.rows[0]!.id);
  }

  const sync = await client.query<{ id: string }>(
    `insert into general_sync_runs(
       request_key, status, trigger_source, sync_mode, batch_count, record_count
     ) values ($1, 'completed', 'scheduled', 'scheduled_recheck', $2, $2)
     returning id`,
    ["test-dedup-" + suffix, count]
  );
  await client.query(
    `insert into general_sync_run_eligible_links (
       run_id, member_link_id, batch_id, target_installment_ref_id
     )
     select $1::uuid, id, batch_id, target_installment_ref_id
       from campaign_batch_members
      where id = any($2::uuid[])`,
    [sync.rows[0]!.id, links]
  );
  const job = await client.query<{ id: string }>(
    `insert into processing_jobs(
       campaign_id, batch_id, status, general_sync_run_id
     ) values ($1::uuid, $2::uuid, 'completed', $3::uuid) returning id`,
    [campaignId, batchIds[0], sync.rows[0]!.id]
  );

  return {
    campaignId,
    batchIds,
    links,
    memberId: member.rows[0]!.id,
    runId: sync.rows[0]!.id,
    jobId: job.rows[0]!.id
  };
}

async function persistSimulatedErpSuccess(
  client: PoolClient,
  linkId: string,
  status: "paid" | "unpaid" | "agreed" | "excluded"
) {
  // Simulate the existing financial trigger, not the external ERP transport.
  const paid = status === "paid" ? 5300 : 0;
  const pending = status === "unpaid" ? 5000 : 0;
  const description = {
    paid: "PIX",
    unpaid: "ABERTO",
    agreed: "ACORDADO",
    excluded: "EXCLUIDA"
  }[status];
  await client.query(
    `insert into member_installments (
      campaign_batch_member_id, cod_parcela, payment_description,
      paid_amount_cents, base_amount_cents, final_amount_cents
    ) values ($1::uuid, '123456', $2, $3, 5000, 5000)`,
    [linkId, description, status === "paid" ? paid : null]
  );
  await client.query(
    `update campaign_batch_members
        set processing_status = 'completed',
            payment_status = $2,
            payment_status_source = $3,
            installment_amount_cents = 5000,
            payment_amount_cents = $4,
            total_pending_amount_cents = $5,
            last_erp_status_at = now(),
            last_checked_at = now()
      where id = $1::uuid`,
    [
      linkId,
      status,
      status === "paid" ? "erp_explicit" : "erp_" + status,
      paid,
      pending
    ]
  );
}

describe("general-sync unique targets flag", () => {
  it("fica desativada por padrao", () => {
    const previous = process.env.GENERAL_SYNC_UNIQUE_TARGETS_ENABLED;
    delete process.env.GENERAL_SYNC_UNIQUE_TARGETS_ENABLED;
    expect(generalSyncUniqueTargetsEnabled()).toBe(false);
    process.env.GENERAL_SYNC_UNIQUE_TARGETS_ENABLED = "true";
    expect(generalSyncUniqueTargetsEnabled()).toBe(true);
    if (previous === undefined) delete process.env.GENERAL_SYNC_UNIQUE_TARGETS_ENABLED;
    else process.env.GENERAL_SYNC_UNIQUE_TARGETS_ENABLED = previous;
  });
});

describeDatabase("general-sync unique targets (PostgreSQL rollback)", () => {
  for (const status of ["paid", "unpaid", "agreed", "excluded"] as const) {
    it(`propaga ${status} e evita releitura em quatro lotes`, async () => {
      await rollbackScenario(async (client) => {
        const scenario = await setup(client);
        await persistSimulatedErpSuccess(client, scenario.links[0]!, status);

        await recordSuccessfulGeneralSyncTarget(client, {
          runId: scenario.runId,
          jobId: scenario.jobId,
          batchId: scenario.batchIds[0]!,
          memberLinkId: scenario.links[0]!
        });
        await recordSuccessfulGeneralSyncTarget(client, {
          runId: scenario.runId,
          jobId: scenario.jobId,
          batchId: scenario.batchIds[0]!,
          memberLinkId: scenario.links[0]!
        });

        const once = await client.query<{ count: string }>(
          `select count(*)::text as count from general_sync_run_installments where run_id = $1::uuid`,
          [scenario.runId]
        );
        expect(once.rows[0]!.count).toBe("1");

        for (let i = 1; i < 4; i++) {
          const reused = await reuseSuccessfulGeneralSyncTargets(client, {
            runId: scenario.runId,
            batchId: scenario.batchIds[i]!
          });
          expect(reused).toBe(1);
        }
        const links = await client.query<{
          payment_status: string;
          processing_status: string;
          installment_amount_cents: string;
          payment_amount_cents: string;
          total_pending_amount_cents: string;
        }>(
          `select payment_status, processing_status,
                  installment_amount_cents::text,
                  payment_amount_cents::text,
                  total_pending_amount_cents::text
             from campaign_batch_members where id = any($1::uuid[])`,
          [scenario.links]
        );
        expect(links.rows).toHaveLength(4);
        for (const row of links.rows) {
          expect(row).toEqual({
            payment_status: status,
            processing_status: "completed",
            installment_amount_cents: "5000",
            payment_amount_cents: status === "paid" ? "5300" : "0",
            total_pending_amount_cents: status === "unpaid" ? "5000" : "0"
          });
        }

        // A new general sync must be free to perform a new check.
        expect(await reuseSuccessfulGeneralSyncTargets(client, {
          runId: randomUUID(),
          batchId: scenario.batchIds[1]!
        })).toBe(0);
      });
    });
  }

  it("nao registra falha/retry como sucesso e nao pula outro lote", async () => {
    await rollbackScenario(async (client) => {
      const s = await setup(client, 2);
      await client.query(
        "update campaign_batch_members set processing_status = 'retrying' where id = $1::uuid",
        [s.links[0]]
      );
      await recordSuccessfulGeneralSyncTarget(client, {
        runId: s.runId, jobId: s.jobId, batchId: s.batchIds[0]!, memberLinkId: s.links[0]!
      });
      expect(await reuseSuccessfulGeneralSyncTargets(client, {
        runId: s.runId, batchId: s.batchIds[1]!
      })).toBe(0);
      const state = await client.query<{ processing_status: string }>(
        "select processing_status from campaign_batch_members where id = $1::uuid",
        [s.links[1]]
      );
      expect(state.rows[0]!.processing_status).toBe("pending");
    });
  });

  it("nao conta como reutilizado um sucesso do proprio lote na retomada", async () => {
    await rollbackScenario(async (client) => {
      const s = await setup(client, 2);
      await persistSimulatedErpSuccess(client, s.links[0]!, "unpaid");
      await recordSuccessfulGeneralSyncTarget(client, {
        runId: s.runId, jobId: s.jobId, batchId: s.batchIds[0]!, memberLinkId: s.links[0]!
      });
      await client.query(
        "update campaign_batch_members set processing_status = 'pending' where id = $1::uuid",
        [s.links[0]]
      );
      expect(await reuseSuccessfulGeneralSyncTargets(client, {
        runId: s.runId, batchId: s.batchIds[0]!
      })).toBe(0);
      const state = await client.query<{ processing_status: string }>(
        "select processing_status from campaign_batch_members where id = $1::uuid",
        [s.links[0]]
      );
      expect(state.rows[0]!.processing_status).toBe("completed");
    });
  });

  it("nao conta link que ja era inelegivel no inicio do ciclo", async () => {
    await rollbackScenario(async (client) => {
      const s = await setup(client, 2);
      // Simulates a terminal link absent from the initial eligibility snapshot.
      // Existing canonical propagation can update it but may not count it as reuse.
      await client.query(
        "delete from general_sync_run_eligible_links where run_id = $1::uuid and member_link_id = $2::uuid",
        [s.runId, s.links[1]]
      );
      await persistSimulatedErpSuccess(client, s.links[0]!, "paid");
      await recordSuccessfulGeneralSyncTarget(client, {
        runId: s.runId, jobId: s.jobId,
        batchId: s.batchIds[0]!, memberLinkId: s.links[0]!
      });
      expect(await reuseSuccessfulGeneralSyncTargets(client, {
        runId: s.runId, batchId: s.batchIds[1]!
      })).toBe(0);
    });
  });

  it("nao confunde o mesmo codigo de parcela de associados diferentes", async () => {
    await rollbackScenario(async (client) => {
      const s = await setup(client, 2);
      await persistSimulatedErpSuccess(client, s.links[0]!, "unpaid");
      await recordSuccessfulGeneralSyncTarget(client, {
        runId: s.runId, jobId: s.jobId, batchId: s.batchIds[0]!, memberLinkId: s.links[0]!
      });
      const suffix = randomUUID().replaceAll("-", "");
      const other = await client.query<{ id: string }>(
        `insert into members(cpf, cpf_hash, external_user_code)
         values ($1, $2, $3) returning id`,
        [suffix.slice(0, 11), "other-dedup-" + suffix, suffix.slice(0, 9)]
      );
      const otherLink = await client.query<{ id: string }>(
        `insert into campaign_batch_members(
           campaign_id, batch_id, member_id, target_installment_id, installment_amount_cents
         ) values ($1::uuid, $2::uuid, $3::uuid, '123456', 5000) returning id`,
        [s.campaignId, s.batchIds[1], other.rows[0]!.id]
      );
      expect(await reuseSuccessfulGeneralSyncTargets(client, {
        runId: s.runId, batchId: s.batchIds[1]!
      })).toBe(1);
      const result = await client.query<{ processing_status: string }>(
        "select processing_status from campaign_batch_members where id = $1::uuid",
        [otherLink.rows[0]!.id]
      );
      expect(result.rows[0]!.processing_status).toBe("pending");
    });
  });
});
