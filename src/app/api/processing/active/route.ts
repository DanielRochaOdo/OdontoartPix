import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeProcessingProgress } from "@/lib/processing-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const supabase = createSupabaseAdminClient();
  const { data: jobs, error } = await supabase
    .from("processing_jobs")
    .select("id,campaign_id,batch_id,status,processing_origin,processing_scope,processing_priority,total_items,processed_items,success_items,error_items,include_errors,created_at")
    .in("status", ["queued", "running", "deferred"])
    .order("processing_priority", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json(
      { success: false, error: { message: "Não foi possível consultar o processamento ativo." } },
      { status: 500 }
    );
  }

  const { data: activeRun, error: runError } = await supabase
    .from("general_sync_runs")
    .select(
      "id,status,trigger_source,sync_mode,current_batch_name,last_heartbeat_at,campaign_count,batch_count,record_count,processed_count,success_count,error_count"
    )
    .in("status", ["queued", "running", "cancelling"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runError) {
    return NextResponse.json(
      { success: false, error: { message: "Não foi possível consultar a sincronização ativa." } },
      { status: 500 }
    );
  }

  const rows = jobs ?? [];
  const executableRows = rows.filter((job) => job.status === "queued" || job.status === "running");
  const deferredRows = rows.filter((job) => job.status === "deferred");
  const summary = executableRows.reduce(
    (total, job) => ({
      totalItems: total.totalItems + Number(job.total_items ?? 0),
      processedItems: total.processedItems + Number(job.processed_items ?? 0),
      successItems: total.successItems + Number(job.success_items ?? 0),
      errorItems: total.errorItems + Number(job.error_items ?? 0),
      campaigns: total.campaigns.add(job.campaign_id),
      batches: total.batches.add(job.batch_id)
    }),
    {
      totalItems: 0,
      processedItems: 0,
      successItems: 0,
      errorItems: 0,
      campaigns: new Set<string>(),
      batches: new Set<string>()
    }
  );

  const manualJobCount = rows.filter((job) => job.processing_origin === "manual").length;
  const dashboardJobCount = rows.filter((job) => job.processing_origin === "dashboard").length;
  const unknownJobCount = Math.max(rows.length - manualJobCount - dashboardJobCount, 0);
  const scopeCounts = {
    campaign: rows.filter((job) => job.processing_scope === "campaign").length,
    batch: rows.filter((job) => job.processing_scope === "batch").length,
    member: rows.filter((job) => job.processing_scope === "member").length,
    dashboard: rows.filter((job) => job.processing_scope === "dashboard").length
  };
  const hasActiveRun = Boolean(activeRun);
  const progress = normalizeProcessingProgress({
    totalItems: hasActiveRun ? Number(activeRun?.record_count ?? summary.totalItems) : summary.totalItems,
    processedItems: hasActiveRun ? Number(activeRun?.processed_count ?? summary.processedItems) : summary.processedItems,
    successItems: hasActiveRun ? Number(activeRun?.success_count ?? summary.successItems) : summary.successItems,
    errorItems: hasActiveRun ? Number(activeRun?.error_count ?? summary.errorItems) : summary.errorItems
  });
  const hasExecutableJobs = executableRows.length > 0;

  return NextResponse.json({
    success: true,
    data: {
      active: hasExecutableJobs || hasActiveRun || deferredRows.length > 0,
      jobCount: rows.length,
      executableJobCount: executableRows.length,
      deferredJobCount: deferredRows.length,
      campaignCount: hasActiveRun
        ? Number(activeRun?.campaign_count ?? summary.campaigns.size)
        : summary.campaigns.size,
      batchCount: hasActiveRun
        ? Number(activeRun?.batch_count ?? summary.batches.size)
        : summary.batches.size,
      totalItems: progress.totalItems,
      processedItems: progress.processedItems,
      successItems: progress.successItems,
      errorItems: progress.errorItems,
      origins: {
        manual: manualJobCount,
        dashboard: dashboardJobCount,
        unknown: unknownJobCount
      },
      scopes: scopeCounts,
      generalSync: activeRun
        ? {
            id: activeRun.id,
            status: activeRun.status,
            triggerSource: activeRun.trigger_source,
            syncMode: activeRun.sync_mode,
            currentBatchName: activeRun.current_batch_name,
            lastHeartbeatAt: activeRun.last_heartbeat_at
          }
        : null,
      jobs: rows.map((job) => ({
        id: job.id,
        campaignId: job.campaign_id,
        batchId: job.batch_id,
        status: job.status,
        origin: job.processing_origin,
        scope: job.processing_scope,
        priority: Number(job.processing_priority ?? 0),
        totalItems: Number(job.total_items ?? 0),
        processedItems: Number(job.processed_items ?? 0),
        includeErrors: Boolean(job.include_errors)
      }))
    }
  });
}
