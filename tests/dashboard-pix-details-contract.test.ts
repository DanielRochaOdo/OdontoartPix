import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PIX_PAYMENT_DESCRIPTIONS = [
  "PIX",
  "PIX - CLINICO",
  "PIX - ORTODONTIA",
  "PIX NEW ODONTO - P4X",
  "PIX NEW ODONTOLOGIA - P4X",
  "PIX ODONTOART - P4X",
  "PIX RECORRENTE ODONTOART - P4X"
];

describe("dashboard Pix details contract", () => {
  it("conta parcelas Pix e associados unicos na fonte canonica e no mesmo escopo", () => {
    const route = readFileSync(
      resolve(process.cwd(), "src/app/api/dashboard/pix-details/route.ts"),
      "utf8"
    );

    expect(route).toContain("select distinct cbm.target_installment_ref_id");
    expect(route).toContain("join member_target_installments canonical");
    expect(route).not.toContain("from member_installments mi");
    expect(route).toContain('count(*)::int as "installmentCount"');
    expect(route).toContain('count(distinct member_id)::int as "memberCount"');
    expect(route).toContain("upper(trim(payment_description)) in (");
    expect(route).not.toContain("upper(payment_description) like '%PIX%'");
    for (const description of PIX_PAYMENT_DESCRIPTIONS) {
      expect(route).toContain(`'${description}'`);
    }
    expect(route).toContain("cbm.campaign_id = any($1::uuid[])");
    expect(route).toContain("cbm.batch_id = any($2::uuid[])");
  });
});
