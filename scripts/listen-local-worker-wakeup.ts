import { spawn, type ChildProcess } from "node:child_process";
import { getDbPool } from "../src/lib/db/pool";
import { WORKER_WAKEUP_CHANNEL } from "../src/lib/worker-wakeup-channel";
import { createWorkerWakeupController } from "../src/lib/worker-wakeup-controller";

const pool = getDbPool();
let closing = false;
let activeChild: ChildProcess | null = null;

function integerSetting(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} deve ser um inteiro entre 1 e ${max}.`);
  }
  return parsed;
}

const limit = integerSetting("WORKER_WAKEUP_LIMIT", 80, 500);
const concurrency = integerSetting("WORKER_WAKEUP_CONCURRENCY", 80, 100);
const maxCycles = integerSetting("WORKER_WAKEUP_MAX_CYCLES", 10, 100);

function runWorker(): Promise<void> {
  if (closing) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const args = [
      "run", "worker:once", "--",
      `--limit=${limit}`,
      `--concurrency=${concurrency}`,
      "--drain",
      "--delay-ms=0",
      `--max-cycles=${maxCycles}`
    ];
    const child = spawn("npm", args, { stdio: "inherit", env: process.env });
    activeChild = child;
    child.once("error", (error) => {
      activeChild = null;
      reject(error);
    });
    child.once("close", (code, signal) => {
      activeChild = null;
      if (code === 0) resolve();
      else reject(new Error(`worker encerrou com code=${code} signal=${signal}`));
    });
  });
}

async function main() {
  const client = await pool.connect();
  const controller = createWorkerWakeupController(runWorker, (error) => {
    console.error("[WORKER_WAKEUP_RUN_FAILED]", error);
  });

  function fatal(error: unknown) {
    if (closing) return;
    console.error("[WORKER_WAKEUP_LISTENER_DISCONNECTED]", error);
    process.exit(1); // systemd restarts the listener; the 60s timer remains as fallback.
  }

  client.on("error", fatal);
  client.on("end", () => fatal(new Error("PostgreSQL LISTEN connection ended")));

  // A fixed channel name; no user input is interpolated into the identifier.
  await client.query(`LISTEN ${WORKER_WAKEUP_CHANNEL}`);
  client.on("notification", (message) => {
    if (message.channel !== WORKER_WAKEUP_CHANNEL || closing) return;
    console.info("[WORKER_WAKEUP_RECEIVED]", { kind: message.payload?.split(":")[0] ?? "unknown" });
    controller.wake();
  });
  console.info("[WORKER_WAKEUP_LISTENING]", { channel: WORKER_WAKEUP_CHANNEL, limit, concurrency, maxCycles });

  // Recover committed requests that preceded LISTEN (e.g. during deployment).
  const outstanding = await client.query<{ has_work: boolean }>(`
    select (
      exists (select 1 from general_sync_runs
               where status in ('queued', 'running', 'cancelling'))
      or exists (select 1 from processing_jobs
               where status in ('queued', 'deferred'))
    ) as has_work`
  );
  if (outstanding.rows[0]?.has_work) {
    console.info("[WORKER_WAKEUP_STARTUP_RECOVERY]");
    controller.wake();
  }

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    controller.stop();
    if (activeChild && !activeChild.killed) activeChild.kill("SIGTERM");
    try {
      await client.query(`UNLISTEN ${WORKER_WAKEUP_CHANNEL}`);
    } catch {}
    client.release();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}

main().catch((error) => {
  console.error("[WORKER_WAKEUP_FATAL]", error);
  process.exit(1);
});
