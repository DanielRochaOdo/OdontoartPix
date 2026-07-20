import { NextResponse } from "next/server";
import { processNextJobBlock } from "@/lib/batch-processing";

export const runtime = "nodejs";
export const maxDuration = 60;
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
    console.info("[CRON_PROCESSING_STARTED]", { startedAt: new Date().toISOString() });
    const result = await processNextJobBlock();
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
