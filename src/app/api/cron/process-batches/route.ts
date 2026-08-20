import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 5;
export const dynamic = "force-dynamic";

// Trava de seguranca: processamento pesado nunca deve voltar a executar dentro
// de uma Function Vercel. O worker duravel vive exclusivamente no GitHub
// Actions e o agendamento automatico e despachado pelo Supabase Cron.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");

  if (secret && authorization !== `Bearer ${secret}`) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "UNAUTHORIZED", message: "Acesso não autorizado." }
      },
      { status: 401 }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: {
        code: "VERCEL_PROCESSING_DISABLED",
        message: "Processamento pesado desativado na Vercel. Utilize o worker durável do GitHub Actions."
      }
    },
    { status: 410 }
  );
}
