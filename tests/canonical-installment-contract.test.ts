import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("canonical installment business contract", () => {
  it("permite a parcela em outros lotes, mas nao duplica no mesmo lote", () => {
    const migration = source("db/migrations/023_canonical_target_installments.sql");
    const importer = source("src/app/api/campanhas/importar-v2/route.ts");

    expect(migration).toContain("member_target_installments_unique_member_code");
    expect(migration).toContain("campaign_batch_members_batch_target_ref_unique");
    expect(importer).toContain("on conflict (batch_id, member_id, target_installment_id)");
    expect(importer).toContain("do nothing");
    expect(importer).not.toContain("Parcela ja vinculada a campanha");
  });

  it("deduplica valores e associados pela identidade canonica", () => {
    const metrics = source("src/lib/metrics.ts");
    const associados = source("src/lib/associados-card-read.ts");

    expect(metrics).toContain("group by cbm.target_installment_ref_id");
    expect(metrics).toContain("join member_target_installments canonical");
    expect(associados).toContain("group by target_installment_ref_id");
    expect(associados).toContain("string_agg(distinct campaign_name");
    expect(associados).toContain("string_agg(distinct batch_name");
  });

  it("mantem paid, agreed e excluded terminais no automatico, sem bloquear o manual", () => {
    const worker = source("src/lib/local-processing-worker.ts");
    const queue = source("src/lib/member-reprocess-queue.ts");

    expect(worker).toContain("payment_status not in ('paid', 'agreed', 'excluded')");
    expect(worker).toContain("$4::uuid is not null");
    expect(queue).toContain("next_check_at = now()");
  });
});
