import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { shouldContinueLocalDrain } from "@/lib/local-worker-drain";

const workerEntrypointSource = readFileSync(
  new URL("../scripts/process-local-worker.ts", import.meta.url),
  "utf8"
);
const localWorkerSource = readFileSync(
  new URL("../src/lib/local-processing-worker.ts", import.meta.url),
  "utf8"
);

it("drain devolve o controle ao systemd quando um job nao faz progresso", () => {
  expect(workerEntrypointSource).toContain("if (!shouldContinueLocalDrain({");
  expect(workerEntrypointSource).toMatch(/LOCAL_WORKER_NO_PROGRESS_BREAK/);
  expect(workerEntrypointSource).toMatch(
    /if \(!drain\) return;[\s\S]*if \(!shouldContinueLocalDrain/
  );
});

it.each(["batch_completed_no_job", "completed_empty_batch"])(
  "drain continua apos %s sem job e permite reconciliar o fim do run", advanceAction => {
    expect(shouldContinueLocalDrain({ jobStatus: "idle", claimed: 0, advanceAction })).toBe(true);
    expect(shouldContinueLocalDrain({ jobStatus: "completed", claimed: 12 })).toBe(true);
    expect(shouldContinueLocalDrain({ jobStatus: "idle", claimed: 0 })).toBe(false);
  }
);

it.each([undefined, "active_batch", "waiting_active_job", "no_pending_batch", "cancelling", "unknown"])(
  "nao gira sem trabalho para acao %s", advanceAction => {
    expect(shouldContinueLocalDrain({ jobStatus: "idle", claimed: 0, advanceAction })).toBe(false);
    expect(shouldContinueLocalDrain({ jobStatus: "queued", claimed: 0, advanceAction })).toBe(false);
  }
);

it("falha do worker encerra drain mesmo havendo claims", () => {
  expect(shouldContinueLocalDrain({ jobStatus: "failed", claimed: 2 })).toBe(false);
});

it("recuperacao de lease cancela job com parada solicitada", () => {
  const recoveryGuard = /status = case when stop_requested_at is null then 'queued' else 'cancelled' end/;
  expect(workerEntrypointSource).toMatch(recoveryGuard);
  expect(localWorkerSource).toMatch(recoveryGuard);
  expect(localWorkerSource).toMatch(
    /next_run_at = case when stop_requested_at is null then now\(\) else null end/
  );
});

it("jobs individuais e gerais ignoram parcelas terminais inclusive no canonico", () => {
  expect(localWorkerSource).not.toContain("$4::uuid is not null\n            or payment_status");
  expect(localWorkerSource).not.toContain("$3::uuid is not null or payment_status");
  expect(localWorkerSource).toContain("and (payment_status is null or payment_status not in ('paid', 'agreed', 'excluded'))");
  expect(localWorkerSource).toContain("canonical.payment_status in ('paid', 'agreed', 'excluded')");
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
