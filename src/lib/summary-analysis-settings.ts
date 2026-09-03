import { dbQuery } from "@/lib/db/pool";

export type SummaryAnalysisSettings = {
  dispatchUnitCostCents: number;
  updatedAt: string | null;
};

type SummaryAnalysisSettingsRow = {
  dispatch_unit_cost_cents: number;
  updated_at: string | null;
};

export async function getSummaryAnalysisSettings(): Promise<SummaryAnalysisSettings> {
  const result = await dbQuery<SummaryAnalysisSettingsRow>(
    `select dispatch_unit_cost_cents::float8 as dispatch_unit_cost_cents,
            updated_at::text
       from summary_analysis_settings
      where settings_key = 'default'
      limit 1`
  );

  return {
    dispatchUnitCostCents: Math.max(0, Number(result.rows[0]?.dispatch_unit_cost_cents ?? 7)),
    updatedAt: result.rows[0]?.updated_at ?? null
  };
}

export async function updateSummaryAnalysisSettings(
  dispatchUnitCostCents: number,
  updatedBy: string
): Promise<SummaryAnalysisSettings> {
  const normalized = Math.max(0, Math.round(dispatchUnitCostCents));
  const result = await dbQuery<SummaryAnalysisSettingsRow>(
    `insert into summary_analysis_settings(
       settings_key,
       dispatch_unit_cost_cents,
       updated_by,
       updated_at
     )
     values ('default', $1, $2::uuid, now())
     on conflict (settings_key) do update
       set dispatch_unit_cost_cents = excluded.dispatch_unit_cost_cents,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at
     returning dispatch_unit_cost_cents::float8 as dispatch_unit_cost_cents,
               updated_at::text`,
    [normalized, updatedBy]
  );

  return {
    dispatchUnitCostCents: Number(result.rows[0]?.dispatch_unit_cost_cents ?? normalized),
    updatedAt: result.rows[0]?.updated_at ?? null
  };
}
