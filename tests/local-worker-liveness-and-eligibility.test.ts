import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workerEntrypointSource = readFileSync(
  new URL("../scripts/process-local-worker.ts", import.meta.url),
  "utf8"
);
const localWorkerSource = readFileSync(
  new URL("../src/lib/local-processing-worker.ts", import.meta.url),
  "utf8"
);

test("drain devolve o controle ao systemd quando um job nao faz progresso", () => {
  assert.match(workerEntrypointSource, /if \(result\.claimed === 0\)/);
  assert.match(workerEntrypointSource, /LOCAL_WORKER_NO_PROGRESS_BREAK/);
  assert.match(
    workerEntrypointSource,
    /if \(!drain \|\| result\.jobStatus === "idle"\) return;[\s\S]*if \(result\.claimed === 0\)/
  );
});

test("recuperacao de lease nao ressuscita job com parada solicitada", () => {
  const recoveryGuard = /status = case when stop_requested_at is null then 'queued' else 'paused' end/;
  assert.match(workerEntrypointSource, recoveryGuard);
  assert.match(localWorkerSource, recoveryGuard);
  assert.match(
    localWorkerSource,
    /next_run_at = case when stop_requested_at is null then now\(\) else null end/
  );
});

test("jobs gerais ignoram quitados e acordados mas o reprocessamento individual continua explicito", () => {
  assert.match(
    localWorkerSource,
    /\$4::uuid is not null[\s\S]*payment_status not in \('paid', 'agreed'\)/
  );
  assert.match(
    localWorkerSource,
    /\$3::uuid is not null or payment_status is null or payment_status not in \('paid','agreed'\)/
  );
});

test("replay filtrado usa o snapshot da requisicao no claim e na finalizacao", () => {
  assert.match(localWorkerSource, /filtered_error_request_id/);
  assert.match(localWorkerSource, /from filtered_error_reprocess_items replay_item/);
  assert.match(localWorkerSource, /replay_item\.request_id = \$5::uuid/);
  assert.match(localWorkerSource, /replay_item\.request_id = \$4::uuid/);
  assert.match(localWorkerSource, /replay_item\.member_link_id = campaign_batch_members\.id/);
});

test("jobs individuais vencem o desempate dentro da mesma prioridade", () => {
  assert.match(
    localWorkerSource,
    /order by processing_priority desc,[\s\S]*case when processing_scope = 'member' then 0 else 1 end/
  );
});
