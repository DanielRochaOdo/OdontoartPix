import { randomUUID } from "node:crypto";
import {
  GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL,
  GENERAL_SYNC_TWO_WAVE_ELIGIBILITY_SQL,
  GENERAL_SYNC_TWO_WAVE_RESERVE_SQL
} from "@/lib/processing-persistence-pilot";
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

describeDatabase("manual general sync persistence preflight (PostgreSQL rollback)", () => {
  it("seleciona somente o primeiro lote nao vazio de uma sync manual ativa", async () => {
    await rollbackScenario(async (client) => {
      const scenario = await setup(client, 3);
      for (let i = 0; i < scenario.batchIds.length; i++) {
        await client.query(
          `insert into general_sync_run_batches(
             run_id, batch_id, campaign_id, batch_name, position, record_count
           ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
          [
            scenario.runId, scenario.batchIds[i], scenario.campaignId,
            "Batch " + i, i + 1, i === 0 ? 0 : 3
          ]
        );
      }

      async function eligible(batchIndex: number) {
        const result = await client.query<{ eligible: boolean }>(
          GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL,
          [scenario.runId, scenario.batchIds[batchIndex]]
        );
        return result.rows[0]?.eligible === true;
      }

      // A paused/completed run or a scheduled run must NEVER use the pilot.
      expect(await eligible(1)).toBe(false);
      await client.query(
        `update general_sync_runs
            set status = 'running', trigger_source = 'manual', sync_mode = 'full_sync'
          where id = $1::uuid`,
        [scenario.runId]
      );
      expect(await eligible(0)).toBe(false); // Empty first batch skipped.
      expect(await eligible(1)).toBe(true);  // First nonempty batch only.
      expect(await eligible(2)).toBe(false);

      await client.query(
        "update general_sync_runs set trigger_source = 'scheduled' where id = $1::uuid",
        [scenario.runId]
      );
      expect(await eligible(1)).toBe(false);
      await client.query(
        "update general_sync_runs set trigger_source = 'manual', sync_mode = 'error_reprocess' where id = $1::uuid",
        [scenario.runId]
      );
      expect(await eligible(1)).toBe(false);
      await client.query(
        "update general_sync_runs set sync_mode = 'full_sync', status = 'paused' where id = $1::uuid",
        [scenario.runId]
      );
      expect(await eligible(1)).toBe(false);
    });
  });
});

describeDatabase("two-wave general-sync pilot reservation (PostgreSQL rollback)", () => {
  it("admite apenas sync filtrada com um lote e reserva cada onda uma vez", async () => {
    await rollbackScenario(async (client) => {
      const test = await setup(client, 1);
      const workerId = randomUUID();

      await client.query(
        `insert into general_sync_run_batches(
           run_id, batch_id, campaign_id, batch_name, position, record_count
         ) values ($1::uuid, $2::uuid, $3::uuid, 'Wave Pilot', 1, 240)`,
        [test.runId, test.batchIds[0], test.campaignId]
      );
      await client.query(
        `update general_sync_runs
            set status = 'running', trigger_source = 'manual',
                sync_mode = 'full_sync', scope_type = 'filtered', batch_count = 1
          where id = $1::uuid`,
        [test.runId]
      );
      await client.query(
        `update processing_jobs
            set status = 'running', locked_by = $2::text,
                total_items = 240, processed_items = 0,
                success_items = 0, error_items = 0
          where id = $1::uuid`,
        [test.jobId, workerId]
      );

      async function eligible() {
        const result = await client.query<{ eligible: boolean }>(
          GENERAL_SYNC_TWO_WAVE_ELIGIBILITY_SQL, [test.runId, test.batchIds[0]]
        );
        return result.rows[0]?.eligible === true;
      }
      async function reserve(stage: 1 | 2) {
        const result = await client.query(
          GENERAL_SYNC_TWO_WAVE_RESERVE_SQL, [test.jobId, workerId, stage]
        );
        return result.rowCount;
      }
      expect(await eligible()).toBe(true);
      expect(await reserve(2)).toBe(0); // No second wave before first.
      expect(await reserve(1)).toBe(1);
      expect(await reserve(1)).toBe(0); // Crash/retry cannot replay first.
      expect(await reserve(2)).toBe(0); // Not ready before clean first wave.

      await client.query(
        `update processing_jobs
            set processed_items = 160, success_items = 160,
                general_sync_two_wave_ready = true
          where id = $1::uuid`,
        [test.jobId]
      );
      expect(await reserve(2)).toBe(1);
      expect(await reserve(2)).toBe(0);
      expect(await reserve(1)).toBe(0);
      const final = await client.query<{
        general_sync_two_wave_pilot_wave: number;
        general_sync_two_wave_ready: boolean;
      }>(
        `select general_sync_two_wave_pilot_wave, general_sync_two_wave_ready
           from processing_jobs where id = $1::uuid`, [test.jobId]
      );
      expect(final.rows[0]).toMatchObject({
        general_sync_two_wave_pilot_wave: 2,
        general_sync_two_wave_ready: false
      });

      await client.query(
        "update general_sync_runs set trigger_source = 'scheduled' where id = $1::uuid",
        [test.runId]
      );
      expect(await eligible()).toBe(false);
      await client.query(
        "update general_sync_runs set trigger_source = 'manual', scope_type = 'all' where id = $1::uuid",
        [test.runId]
      );
      expect(await eligible()).toBe(false);
      await client.query(
        "update general_sync_runs set scope_type = 'filtered', batch_count = 2 where id = $1::uuid",
        [test.runId]
      );
      expect(await eligible()).toBe(false);
    });
  });
});

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

        // Inspect the stored summary immediately after reuse, before any
        // worker finalization or independent repair can hide stale totals.
        const summaries = await client.query(
          `select total_records, processed_records, paid_records, unpaid_records,
                  error_records, total_amount_cents::text as amount,
                  total_pending_amount_cents::text as pending, status
             from campaign_batches where id = any($1::uuid[])`,
          [scenario.batchIds]
        );
        expect(summaries.rows).toEqual(Array.from({ length: 4 }, () => ({
          total_records: 1, processed_records: 1, paid_records: status === "paid" ? 1 : 0,
          unpaid_records: status === "unpaid" ? 1 : 0, error_records: 0,
          amount: "5000", pending: status === "unpaid" ? "5000" : "0", status: "concluido"
        })));

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
      await client.query("select recalculate_batch_totals($1)", [s.batchIds[0]]);
      expect(await reuseSuccessfulGeneralSyncTargets(client, {
        runId: s.runId, batchId: s.batchIds[0]!
      })).toBe(0);
      const state = await client.query<{ processing_status: string }>(
        "select processing_status from campaign_batch_members where id = $1::uuid",
        [s.links[0]]
      );
      expect(state.rows[0]!.processing_status).toBe("completed");
      const summary = await client.query(
        "select processed_records, status from campaign_batches where id = $1::uuid",
        [s.batchIds[0]]
      );
      expect(summary.rows[0]).toEqual({ processed_records: 1, status: "concluido" });
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
      const summary = (await client.query(
        "select total_records, processed_records, status from campaign_batches where id=$1", [s.batchIds[1]]
      )).rows[0];
      expect(summary).toEqual({ total_records: 2, processed_records: 1, status: "aguardando" });
    });
  });

  it("mantem guard anterior e desfaz vinculo e resumo juntos no rollback", async () => {
    await rollbackScenario(async client => {
      const s = await setup(client, 2);
      await persistSimulatedErpSuccess(client, s.links[0]!, "unpaid");
      await recordSuccessfulGeneralSyncTarget(client, {
        runId: s.runId, jobId: s.jobId, batchId: s.batchIds[0]!, memberLinkId: s.links[0]!
      });
      const before = (await client.query(
        "select processed_records, status from campaign_batches where id=$1", [s.batchIds[1]]
      )).rows[0];
      expect(before).toEqual({ processed_records: 0, status: "aguardando" });
      await client.query("savepoint before_reuse");
      await client.query("select set_config('odontoart.canonical_sync','on',true)");
      expect(await reuseSuccessfulGeneralSyncTargets(client, { runId: s.runId, batchId: s.batchIds[1]! })).toBe(1);
      expect((await client.query("select current_setting('odontoart.canonical_sync') as value")).rows[0].value).toBe("on");
      expect((await client.query("select processed_records, status from campaign_batches where id=$1", [s.batchIds[1]])).rows[0])
        .toEqual({ processed_records: 1, status: "concluido" });
      await client.query("rollback to savepoint before_reuse");
      expect((await client.query("select processed_records, status from campaign_batches where id=$1", [s.batchIds[1]])).rows[0]).toEqual(before);
      expect((await client.query("select processing_status from campaign_batch_members where id=$1", [s.links[1]])).rows[0].processing_status).toBe("pending");
    });
  });

  it.each(["processing", "deleted"])("nao reutiliza vinculo %s", async mode => {
    await rollbackScenario(async client => {
      const s = await setup(client, 2);
      await persistSimulatedErpSuccess(client, s.links[0]!, "unpaid");
      await recordSuccessfulGeneralSyncTarget(client, {
        runId: s.runId, jobId: s.jobId, batchId: s.batchIds[0]!, memberLinkId: s.links[0]!
      });
      await client.query(mode === "processing"
        ? "update campaign_batch_members set processing_status='processing', processing_owner=gen_random_uuid() where id=$1"
        : "update campaign_batch_members set deleted_at=now() where id=$1", [s.links[1]]);
      await client.query("select recalculate_batch_totals($1)", [s.batchIds[1]]);
      const before = (await client.query("select to_jsonb(cbm) as value from campaign_batch_members cbm where id=$1", [s.links[1]])).rows;
      expect(await reuseSuccessfulGeneralSyncTargets(client, { runId: s.runId, batchId: s.batchIds[1]! })).toBe(0);
      expect((await client.query("select to_jsonb(cbm) as value from campaign_batch_members cbm where id=$1", [s.links[1]])).rows).toEqual(before);
      expect((await client.query("select status from campaign_batches where id=$1", [s.batchIds[1]])).rows[0].status)
        .toBe(mode === "processing" ? "processando" : "aguardando");
    });
  });
});
