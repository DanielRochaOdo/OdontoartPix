import { getDbPool } from "../src/lib/db/pool";
import { runLocalGeneralSyncCycle } from "../src/lib/general-sync-orchestrator";
import { startDueLocalScheduledGeneralSync } from "../src/lib/general-sync-scheduled-start";
import { finalizeQueuedLocalProcessingPauseRequests } from "../src/lib/local-processing-pause-checkpoint";
import { runLocalWorkerOnce } from "../src/lib/local-processing-worker";

const ADVISORY_LOCK_NAMESPACE = 17483621;
const ADVISORY_LOCK_WORKER = 20260821;
const DEFAULT_DRAIN_DELAY_MS = 5000;
const DEFAULT_MAX_DRAIN_CYCLES = 1000;

function readPositiveIntegerArgument(name: string) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (!argument) return undefined;

  const parsed = Number(argument.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${prefix} deve receber um inteiro maior que zero.`);
  }
  return parsed;
}

function readNonNegativeIntegerArgument(name: string) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (!argument) return undefined;

  const parsed = Number(argument.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${prefix} deve receber um inteiro maior ou igual a zero.`);
  }
  return parsed;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function recoverInterruptedLocalWork() {
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query("begin");

    const interruptedJobs = await client.query<{ id: string; batch_id: string }>(
      `select id, batch_id
         from processing_jobs
        where status = 'running'
        for update`
    );

    if (interruptedJobs.rows.length === 0) {
      await client.query("commit");
      return { jobs: 0, members: 0 };
    }

    const jobIds = interruptedJobs.rows.map((row) => row.id);
    const batchIds = [...new Set(interruptedJobs.rows.map((row) => row.batch_id))];

    const reclaimedMembers = await client.query(
      `update campaign_batch_members
          set processing_status = 'retrying',
              processing_owner = null,
              claim_token = null,
              claimed_at = null,
              processing_started_at = null,
              processing_heartbeat_at = null,
              next_retry_at = now(),
              stale_reclaim_count = stale_reclaim_count + 1,
              processing_error_code = 'PROCESSING_WORKER_RECOVERY',
              last_error = 'Processamento recuperado automaticamente apos interrupcao do worker local.',
              updated_at = now()
        where batch_id = any($1::uuid[])
          and deleted_at is null
          and processing_status = 'processing'`,
      [batchIds]
    );

    await client.query(
      `update processing_jobs
          set status = 'queued',
              next_run_at = now(),
              locked_by = null,
              locked_at = null,
              lease_expires_at = null,
              last_heartbeat_at = null,
              finished_at = null,
              updated_at = now()
        where id = any($1::uuid[])`,
      [jobIds]
    );

    await client.query("commit");
    return {
      jobs: interruptedJobs.rows.length,
      members: reclaimedMembers.rowCount ?? 0
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = getDbPool();
  const lockClient = await pool.connect();
  let lockAcquired = false;

  try {
    const lockResult = await lockClient.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock($1::integer, $2::integer) as acquired`,
      [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_WORKER]
    );

    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) {
      console.info("[LOCAL_WORKER_ALREADY_RUNNING]");
      return;
    }

    const recovered = await recoverInterruptedLocalWork();
    if (recovered.jobs > 0 || recovered.members > 0) {
      console.warn("[LOCAL_WORKER_RECOVERY]", recovered);
    }

    const claimLimit = readPositiveIntegerArgument("limit");
    const concurrency = readPositiveIntegerArgument("concurrency");
    const drain = hasFlag("drain");
    const orchestrationOnly = hasFlag("orchestration-only");
    const delayMs = readNonNegativeIntegerArgument("delay-ms") ?? DEFAULT_DRAIN_DELAY_MS;
    const maxDrainCycles = readPositiveIntegerArgument("max-cycles") ?? DEFAULT_MAX_DRAIN_CYCLES;
    let productiveCycles = 0;

    while (true) {
      // O estado processing_scheduler_state.scheduler_enabled e a fonte unica
      // de verdade para a criacao automatica de novas sincronizacoes. Quando
      // desativado pela interface, esta chamada retorna action=disabled e o
      // worker continua consumindo normalmente os jobs iniciados manualmente.
      const scheduledStartResult = await startDueLocalScheduledGeneralSync();
      console.info("[LOCAL_SCHEDULED_SYNC_START_COMPLETED]", scheduledStartResult);

      const generalSyncResult = await runLocalGeneralSyncCycle();
      console.info("[LOCAL_GENERAL_SYNC_CYCLE_COMPLETED]", generalSyncResult);

      const pauseCheckpoint = await finalizeQueuedLocalProcessingPauseRequests();
      if (pauseCheckpoint.pausedJobs > 0) {
        console.info("[LOCAL_WORKER_PAUSE_CHECKPOINT]", pauseCheckpoint);
      }

      if (orchestrationOnly) {
        console.info("[LOCAL_WORKER_PROCESSING_SKIPPED]");
        return;
      }

      const result = await runLocalWorkerOnce({ claimLimit, concurrency });
      console.info("[LOCAL_WORKER_RUN_COMPLETED]", result);

      if (result.jobStatus === "failed") {
        process.exitCode = 1;
        return;
      }

      if (!drain || result.jobStatus === "idle") return;

      productiveCycles += 1;
      if (productiveCycles >= maxDrainCycles) {
        console.warn("[LOCAL_WORKER_DRAIN_LIMIT_REACHED]", {
          productiveCycles,
          maxDrainCycles
        });
        return;
      }

      if (delayMs > 0) await sleep(delayMs);
    }
  } finally {
    if (lockAcquired) {
      await lockClient.query(
        `select pg_advisory_unlock($1::integer, $2::integer)`,
        [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_WORKER]
      );
    }
    lockClient.release();
  }
}

main()
  .catch((error) => {
    console.error("[LOCAL_WORKER_FATAL]", {
      message: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await getDbPool().end();
  });
