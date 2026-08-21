import { runLocalWorkerOnce } from "../src/lib/local-processing-worker";

function readClaimLimit() {
  const argument = process.argv.find((value) => value.startsWith("--limit="));
  if (!argument) return undefined;
  const parsed = Number(argument.slice("--limit=".length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--limit deve ser um inteiro maior que zero.");
  }
  return parsed;
}

async function main() {
  const result = await runLocalWorkerOnce({ claimLimit: readClaimLimit() });
  console.info("[LOCAL_WORKER_RUN_COMPLETED]", result);
  if (result.jobStatus === "failed") process.exitCode = 1;
}

main().catch((error) => {
  console.error("[LOCAL_WORKER_FATAL]", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
