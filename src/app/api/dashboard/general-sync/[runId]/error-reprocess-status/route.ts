import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ runId: z.string().uuid() });

type ReplayRow = {
  request_id: string;
  status: "queued" | "processing" | "retrying" | "resolved" | "failed";
  requested_at: string;
};

type EventRow = {
  id: string;
  event_type: string;
  details: Record<string, unknown> | null;
  created_at: string;
};

function numberFromDetails(details: Record<string, unknown> | null, key: string) {
  const value = Number(details?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function activityLabel(event: EventRow) {
  if (event.event_type === "dashboard_errors_absorbed") {
    const count = numberFromDetails(event.details, "requestedCount");
    return `${count} erro(s) adicionados ao pedido fechado`;
  }

  if (event.event_type === "dashboard_error_reprocess_started") {
    const count = numberFromDetails(event.details, "requestedCount");
    return `${count} erro(s) do pedido entraram em reprocessamento`;
  }

  if (event.event_type === "dashboard_error_reprocess_completed") {
    const resolved = numberFromDetails(event.details, "resolvedCount");
    const failed = numberFromDetails(event.details, "failedCount");
    return `${resolved} erro(s) resolvidos · ${failed} permaneceram com erro`;
  }

  return "Atualização da tratativa de erros";
}

export async function GET(
  _: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Sincronizacao geral invalida.", 400);

  try {
    const supabase = createSupabaseAdminClient();

    const { data: latest, error: latestError } = await supabase
      .from("dashboard_error_reprocess_items")
      .select("request_id,requested_at")
      .eq("run_id", parsed.data.runId)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) throw latestError;

    if (!latest) {
      return ok({
        runId: parsed.data.runId,
        requestId: null,
        requestedAt: null,
        requestedCount: 0,
        queuedCount: 0,
        processingCount: 0,
        resolvedCount: 0,
        failedCount: 0,
        completedCount: 0,
        remainingCount: 0,
        activities: []
      });
    }

    const requestId = String(latest.request_id);
    const [{ data: rows, error: rowsError }, { data: events, error: eventsError }] = await Promise.all([
      supabase
        .from("dashboard_error_reprocess_items")
        .select("request_id,status,requested_at")
        .eq("run_id", parsed.data.runId)
        .eq("request_id", requestId),
      supabase
        .from("event_logs")
        .select("id,event_type,details,created_at")
        .eq("category", "processing")
        .eq("details->>runId", parsed.data.runId)
        .eq("details->>requestId", requestId)
        .in("event_type", [
          "dashboard_errors_absorbed",
          "dashboard_error_reprocess_started",
          "dashboard_error_reprocess_completed"
        ])
        .order("created_at", { ascending: false })
        .limit(8)
    ]);

    if (rowsError) throw rowsError;
    if (eventsError) throw eventsError;

    const replayRows = (rows ?? []) as ReplayRow[];
    const requestedCount = replayRows.length;
    const queuedCount = replayRows.filter((row) => row.status === "queued" || row.status === "retrying").length;
    const processingCount = replayRows.filter((row) => row.status === "processing").length;
    const resolvedCount = replayRows.filter((row) => row.status === "resolved").length;
    const failedCount = replayRows.filter((row) => row.status === "failed").length;
    const completedCount = resolvedCount + failedCount;
    const remainingCount = Math.max(requestedCount - completedCount, 0);

    return ok({
      runId: parsed.data.runId,
      requestId,
      requestedAt: latest.requested_at,
      requestedCount,
      queuedCount,
      processingCount,
      resolvedCount,
      failedCount,
      completedCount,
      remainingCount,
      activities: ((events ?? []) as EventRow[]).map((event) => ({
        id: event.id,
        type: event.event_type,
        label: activityLabel(event),
        createdAt: event.created_at
      }))
    });
  } catch (error) {
    console.error("[DASHBOARD_ERROR_REPROCESS_STATUS_FAILED]", {
      runId: parsed.data.runId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel carregar a tratativa de erros da onda.", 500);
  }
}
