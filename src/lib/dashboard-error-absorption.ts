import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type DashboardErrorAbsorptionResult = {
  absorbed: boolean;
  runId: string | null;
  jobId: string | null;
  requestedCount: number;
  requestId: string;
};

type AbsorptionRow = {
  absorbed?: boolean;
  run_id?: string | null;
  job_id?: string | null;
  requested_count?: number | string | null;
  request_id?: string | null;
};

export async function absorbBatchErrorsIntoActiveDashboard(
  batchId: string,
  requestId: string
): Promise<DashboardErrorAbsorptionResult> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("absorb_batch_errors_into_dashboard_v6", {
    p_batch_id: batchId,
    p_request_id: requestId
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as AbsorptionRow | null;
  return {
    absorbed: row?.absorbed === true,
    runId: row?.run_id ?? null,
    jobId: row?.job_id ?? null,
    requestedCount: Number(row?.requested_count ?? 0),
    requestId: row?.request_id ?? requestId
  };
}
