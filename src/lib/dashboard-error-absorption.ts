import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type DashboardErrorAbsorptionResult = {
  absorbed: boolean;
  runId: string | null;
  jobId: string | null;
  requestedCount: number;
};

type AbsorptionRow = {
  absorbed?: boolean;
  run_id?: string | null;
  job_id?: string | null;
  requested_count?: number | string | null;
};

export async function absorbBatchErrorsIntoActiveDashboard(
  batchId: string
): Promise<DashboardErrorAbsorptionResult> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("absorb_batch_errors_into_dashboard_v1", {
    p_batch_id: batchId
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as AbsorptionRow | null;
  return {
    absorbed: row?.absorbed === true,
    runId: row?.run_id ?? null,
    jobId: row?.job_id ?? null,
    requestedCount: Number(row?.requested_count ?? 0)
  };
}
