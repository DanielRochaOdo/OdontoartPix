import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("dashboard receipt status associates", () => {
  it("conta associados unicos por DescricaoRecebimento e exibe no detalhamento", () => {
    const metrics = readFileSync(
      resolve(process.cwd(), "src/lib/metrics.ts"),
      "utf8"
    );
    const charts = readFileSync(
      resolve(process.cwd(), "src/components/dashboard-donut-charts.tsx"),
      "utf8"
    );

    expect(metrics).toContain('associateCount: NumberSchema');
    expect(metrics).toContain('count(distinct member_id)::int as "associateCount"');
    expect(metrics).toContain('group by payment_description');
    expect(charts).toContain('associateCount: status.associateCount');
    expect(charts).toContain('Associados:');
  });
});
