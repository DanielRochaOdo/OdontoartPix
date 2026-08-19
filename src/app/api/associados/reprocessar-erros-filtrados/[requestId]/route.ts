import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ requestId: z.string().uuid() });

type RequestRow = {
  id: string;
  requested_count: number;
  batch_count: number;
  campaign_count: number;
  status: "queued" | "running" | "completed";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type ItemRow = {
  status: "queued" | "processing" | "resolved" | "failed";
};

export async function GET(
  _: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Reprocessamento filtrado inválido.", 400);
  }

  try {
    const supabase = createSupabaseAdminClient();
    const [{ data: requestRow, error: requestError }, { data: items, error: itemsError }] = await Promise.all([
      supabase
        .from("filtered_error_reprocess_requests")
        .select("id,requested_count,batch_count,campaign_count,status,created_at,started_at,finished_at")
        .eq("id", parsed.data.requestId)
        .maybeSingle(),
      supabase
        .from("filtered_error_reprocess_items")
        .select("status")
        .eq("request_id", parsed.data.requestId)
    ]);

    if (requestError) throw requestError;
    if (itemsError) throw itemsError;
    if (!requestRow) return fail("NOT_FOUND", "Reprocessamento filtrado não encontrado.", 404);

    const requestData = requestRow as RequestRow;
    const itemRows = (items ?? []) as ItemRow[];
    const queuedCount = itemRows.filter((item) => item.status === "queued").length;
    const processingCount = itemRows.filter((item) => item.status === "processing").length;
    const resolvedCount = itemRows.filter((item) => item.status === "resolved").length;
    const failedCount = itemRows.filter((item) => item.status === "failed").length;
    const attemptedCount = processingCount + resolvedCount + failedCount;
    const completedCount = resolvedCount + failedCount;
    const active = queuedCount > 0 || processingCount > 0;

    return ok({
      requestId: requestData.id,
      requestedCount: requestData.requested_count,
      batchCount: requestData.batch_count,
      campaignCount: requestData.campaign_count,
      status: active ? requestData.status : "completed",
      active,
      queuedCount,
      processingCount,
      attemptedCount,
      completedCount,
      resolvedCount,
      failedCount,
      createdAt: requestData.created_at,
      startedAt: requestData.started_at,
      finishedAt: requestData.finished_at
    });
  } catch (error) {
    console.error("[FILTERED_ERROR_REPROCESS_STATUS_FAILED]", {
      requestId: parsed.data.requestId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível carregar o progresso do reprocessamento filtrado.", 500);
  }
}
