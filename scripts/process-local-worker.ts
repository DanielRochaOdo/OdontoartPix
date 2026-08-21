import { runLocalWorkerOnce } from "../src/lib/local-processing-worker";
import { getDbPool } from "../src/lib/db/pool";

const ADVISORY_LOCK_NAMESPACE = 17483621;
const ADVISORY_LOCK_WORKER = 20260821;

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
              processing_attempts = greatest(processing_attempts - 1, 0),
              processing_owner = null,
              claim_token = null,
              claimed_at = null,
              processing_heartbeat_at = null,
              next_retry_at = now(),
              stale_reclaim_count = stale_reclaim_count + 1,
              last_error = 'Processamento recuperado automaticamente após interrupção do worker local.',
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

    const result = await runLocalWorkerOnce({
      claimLimit: readPositiveIntegerArgument("limit"),
      concurrency: readPositiveIntegerArgument("concurrency")
    });
    console.info("[LOCAL_WORKER_RUN_COMPLETED]", result);
    if (result.jobStatus === "failed") process.exitCode = 1;
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
