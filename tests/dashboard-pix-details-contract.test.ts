import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("dashboard Pix details contract", () => {
  it("conta parcelas Pix e associados unicos no mesmo escopo", () => {
    const route = readFileSync(
      resolve(process.cwd(), "src/app/api/dashboard/pix-details/route.ts"),
      "utf8"
    );

    expect(route).toContain('count(*)::int as "installmentCount"');
    expect(route).toContain('count(distinct member_id)::int as "memberCount"');
    expect(route).toContain("upper(payment_description) like '%PIX%'");
    expect(route).toContain("cbm.campaign_id = any($1::uuid[])");
    expect(route).toContain("cbm.batch_id = any($2::uuid[])");
  });
});
