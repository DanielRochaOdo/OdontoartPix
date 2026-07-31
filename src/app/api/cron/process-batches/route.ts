import { NextResponse } from "next/server";
import { triggerQueuedProcessing } from "@/lib/processing-trigger";

export const runtime = "nodejs";
export const maxDuration = 55;
export const dynamic = "force-dynamic";

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

  try {
    const result = await triggerQueuedProcessing({
      maxRuns: 10000,
      budgetMs: 45000
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
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
