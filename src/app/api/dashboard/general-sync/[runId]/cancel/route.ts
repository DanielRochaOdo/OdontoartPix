import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { getGeneralSyncRun } from "@/lib/general-sync";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const ParamsSchema = z.object({ runId: z.string().uuid() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Sincronizacao geral invalida.", 400);
  }

  const body = await request.json().catch(() => null);
  const reason =
    body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string"
      ? (body as { reason: string }).reason.trim().slice(0, 500)
      : "Sincronizacao geral interrompida manualmente.";

  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.rpc("cancel_dashboard_general_sync_v1", {
      p_run_id: parsed.data.runId,
      p_requested_by: auth.profile.id,
      p_reason: reason
    });
    if (error) {
      if (error.message.includes("general_sync_not_found")) {
        return fail("NOT_FOUND", "Sincronizacao geral nao encontrada.", 404);
      }
      throw error;
    }

    const run = await getGeneralSyncRun(parsed.data.runId);
    return ok(
      run,
      "Sincronizacao geral interrompida e encerrada definitivamente.",
      202
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel cancelar a sincronizacao geral.";
    console.error("[GENERAL_SYNC_CANCEL_FAILED]", {
      runId: parsed.data.runId,
      message
    });
    return fail("DATABASE_ERROR", message, 500);
  }
}
