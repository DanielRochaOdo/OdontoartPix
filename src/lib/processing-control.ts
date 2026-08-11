import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function isProcessingPaused() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("processing_control")
    .select("is_paused")
    .eq("id", true)
    .maybeSingle();

  if (error) throw error;
  return data?.is_paused === true;
}

export async function pauseProcessing(reason: string, requestedBy?: string | null) {
  const supabase = createSupabaseAdminClient();
  const pausedAt = new Date().toISOString();
  const { error: controlError } = await supabase
    .from("processing_control")
    .update({
      is_paused: true,
      paused_at: pausedAt,
      paused_by: requestedBy ?? null,
      pause_reason: reason,
      updated_at: pausedAt
    })
    .eq("id", true);
  if (controlError) throw controlError;

  const { error: runningError } = await supabase
    .from("processing_jobs")
    .update({
      stop_requested_at: pausedAt,
      stop_requested_by: requestedBy ?? null,
      stop_reason: reason,
      updated_at: pausedAt
    })
    .in("status", ["running"]);
  if (runningError) throw runningError;

  const { error: queuedError } = await supabase
    .from("processing_jobs")
    .update({
      status: "paused",
      stop_requested_at: pausedAt,
      stop_requested_by: requestedBy ?? null,
      stop_reason: reason,
      updated_at: pausedAt
    })
    .in("status", ["queued"]);
  if (queuedError) throw queuedError;
}

export async function resumeProcessing() {
  const supabase = createSupabaseAdminClient();
  const resumedAt = new Date().toISOString();
  const { error: controlError } = await supabase
    .from("processing_control")
    .update({
      is_paused: false,
      paused_at: null,
      paused_by: null,
      pause_reason: null,
      updated_at: resumedAt
    })
    .eq("id", true);
  if (controlError) throw controlError;

  const { error } = await supabase
    .from("processing_jobs")
    .update({
      status: "queued",
      stop_requested_at: null,
      stop_requested_by: null,
      stop_reason: null,
      next_run_at: resumedAt,
      finished_at: null,
      updated_at: resumedAt
    })
    .eq("status", "paused");
  if (error) throw error;
}
