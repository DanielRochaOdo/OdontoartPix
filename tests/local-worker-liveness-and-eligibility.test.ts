import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const workerEntrypointSource = readFileSync(
  new URL("../scripts/process-local-worker.ts", import.meta.url),
  "utf8"
);
const localWorkerSource = readFileSync(
  new URL("../src/lib/local-processing-worker.ts", import.meta.url),
  "utf8"
);

it("drain devolve o controle ao systemd quando um job nao faz progresso", () => {
  expect(workerEntrypointSource).toMatch(/if \(result\.claimed === 0\)/);
  expect(workerEntrypointSource).toMatch(/LOCAL_WORKER_NO_PROGRESS_BREAK/);
  expect(workerEntrypointSource).toMatch(
    /if \(!drain \|\| result\.jobStatus === "idle"\) return;[\s\S]*if \(result\.claimed === 0\)/
  );
});

it("recuperacao de lease nao ressuscita job com parada solicitada", () => {
  const recoveryGuard = /status = case when stop_requested_at is null then 'queued' else 'paused' end/;
  expect(workerEntrypointSource).toMatch(recoveryGuard);
  expect(localWorkerSource).toMatch(recoveryGuard);
  expect(localWorkerSource).toMatch(
    /next_run_at = case when stop_requested_at is null then now\(\) else null end/
  );
});

it("jobs gerais ignoram quitados e acordados mas o reprocessamento individual continua explicito", () => {
  expect(localWorkerSource).toMatch(
    /\$4::uuid is not null[\s\S]*payment_status not in \('paid', 'agreed'\)/
  );
  expect(localWorkerSource).toMatch(
    /\$3::uuid is not null or payment_status is null or payment_status not in \('paid','agreed'\)/
  );
});

it("replay filtrado usa o snapshot da requisicao no claim e na finalizacao", () => {
  expect(localWorkerSource).toMatch(/filtered_error_request_id/);
  expect(localWorkerSource).toMatch(/from filtered_error_reprocess_items replay_item/);
  expect(localWorkerSource).toMatch(/replay_item\.request_id = \$5::uuid/);
  expect(localWorkerSource).toMatch(/replay_item\.request_id = \$4::uuid/);
  expect(localWorkerSource).toMatch(/replay_item\.member_link_id = campaign_batch_members\.id/);
});

it("jobs individuais vencem o desempate dentro da mesma prioridade", () => {
  expect(localWorkerSource).toMatch(
    /order by processing_priority desc,[\s\S]*case when processing_scope = 'member' then 0 else 1 end/
  );
});
