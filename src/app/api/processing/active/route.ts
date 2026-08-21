import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { normalizeProcessingProgress } from "@/lib/processing-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActiveJobRow = {
  id: string;
  campaign_id: string | null;
  batch_id: string | null;
  status: string;
  processing_origin: string | null;
  processing_scope: string | null;
  processing_priority: number;
  total_items: number;
  processed_items: number;
  success_items: number;
  error_items: number;
  include_errors: boolean;
};

type ActiveGeneralSyncRow = {
  id: string;
  status: string;
  trigger_source: string;
  sync_mode: string;
  current_batch_name: string | null;
  last_heartbeat_at: Date | string | null;
  campaign_count: number;
  batch_count: number;
  record_count: number;
  processed_count: number;
  success_count: number;
  error_count: number;
};

export async function GET() {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  let jobs: ActiveJobRow[];
  try {
    const result = await dbQuery<ActiveJobRow>(
      `select id,
              campaign_id,
              batch_id,
              status,
              processing_origin,
              processing_scope,
              processing_priority,
              total_items,
              processed_items,
              success_items,
              error_items,
              include_errors
         from processing_jobs
        where status in ('queued', 'running', 'deferred')
        order by processing_priority desc, created_at asc`
    );
    jobs = result.rows;
  } catch (error) {
    console.error("[ACTIVE_PROCESSING_JOBS_QUERY_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return NextResponse.json(
      { success: false, error: { message: "Não foi possível consultar o processamento ativo." } },
      { status: 500 }
    );
  }

  let activeRun: ActiveGeneralSyncRow | null;
  try {
    const result = await dbQuery<ActiveGeneralSyncRow>(
      `select id,
              status,
              trigger_source,
              sync_mode,
              current_batch_name,
              last_heartbeat_at,
              campaign_count,
              batch_count,
              record_count,
              processed_count,
              success_count,
              error_count
         from general_sync_runs
        where status in ('queued', 'running', 'cancelling')
        order by created_at desc
        limit 1`
    );
    activeRun = result.rows[0] ?? null;
  } catch (error) {
    console.error("[ACTIVE_GENERAL_SYNC_QUERY_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return NextResponse.json(
      { success: false, error: { message: "Não foi possível consultar a sincronização ativa." } },
      { status: 500 }
    );
  }

  const rows = jobs;
  const executableRows = rows.filter((job) => job.status === "queued" || job.status === "running");
  const deferredRows = rows.filter((job) => job.status === "deferred");
  const summary = executableRows.reduce(
    (total, job) => ({
      totalItems: total.totalItems + Number(job.total_items ?? 0),
      processedItems: total.processedItems + Number(job.processed_items ?? 0),
      successItems: total.successItems + Number(job.success_items ?? 0),
      errorItems: total.errorItems + Number(job.error_items ?? 0),
      campaigns: job.campaign_id ? total.campaigns.add(job.campaign_id) : total.campaigns,
      batches: job.batch_id ? total.batches.add(job.batch_id) : total.batches
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
