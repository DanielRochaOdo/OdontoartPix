import { runLocalWorkerOnce } from "../src/lib/local-processing-worker";
import { getDbPool } from "../src/lib/db/pool";

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

async function main() {
  const result = await runLocalWorkerOnce({
    claimLimit: readPositiveIntegerArgument("limit"),
    concurrency: readPositiveIntegerArgument("concurrency")
  });
  console.info("[LOCAL_WORKER_RUN_COMPLETED]", result);
  if (result.jobStatus === "failed") process.exitCode = 1;
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
