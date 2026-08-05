import { NextResponse } from "next/server";
import { triggerQueuedProcessing } from "@/lib/processing-trigger";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 55;
export const dynamic = "force-dynamic";

async function recordSchedulerPulse(input: {
  startedAt: string;
  finishedAt?: string | null;
  status: "running" | "completed" | "failed";
  error?: string | null;
}) {
  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.rpc("record_processing_scheduler_pulse_v1", {
      p_started_at: input.startedAt,
      p_finished_at: input.finishedAt ?? null,
      p_status: input.status,
      p_error: input.error ?? null
    });
    if (error) throw error;
  } catch (error) {
    console.error("[CRON_PULSE_RECORD_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
  }
}

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CRON_NOT_CONFIGURED",
          message: "CRON_SECRET não está configurado no servidor."
        }
      },
      { status: 500 }
    );
  }

  if (!isAuthorized(request)) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "UNAUTHORIZED", message: "Acesso não autorizado." }
      },
      { status: 401 }
    );
  }

  const startedAt = new Date().toISOString();
  await recordSchedulerPulse({ startedAt, status: "running" });

  try {
    const systemUserId = request.headers.get("x-processing-system-user-id")?.trim() || null;
    const result = await triggerQueuedProcessing({
      maxRuns: 10000,
      budgetMs: 45000,
      systemUserId,
      allowScheduledSync: true
    });
    await recordSchedulerPulse({
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "completed"
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    await recordSchedulerPulse({
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "failed",
      error: error instanceof Error ? error.message : "Erro desconhecido"
    });
    console.error("[CRON_PROCESSING_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CRON_PROCESSING_FAILED",
          message: "Não foi possível executar o bloco de processamento."
        }
      },
      { status: 500 }
    );
  }
}
