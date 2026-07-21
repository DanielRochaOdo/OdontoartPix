import { z } from "zod";
import { isValidCpf, stripCpf } from "@/lib/cpf";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { consultMonthlyByCpf, ErpError } from "@/lib/mensalidades-api";

const BodySchema = z.object({
  cpf: z.string().min(11).max(14)
});

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Payload inválido.", 400);

  const cpf = stripCpf(parsed.data.cpf);
  if (!isValidCpf(cpf)) return fail("VALIDATION_ERROR", "CPF inválido.", 400);

  try {
    const result = await consultMonthlyByCpf(cpf);
    return ok(
      {
        httpStatus: result.httpStatus,
        durationMs: result.durationMs,
        analysis: result.analysis
      },
      "Consulta realizada."
    );
  } catch (error) {
    if (error instanceof ErpError) {
      const status =
        error.code === "ERP_UNAUTHORIZED"
          ? 502
          : error.code === "ERP_RATE_LIMITED"
            ? 503
            : error.code === "ERP_NOT_CONFIGURED"
              ? 500
              : 502;

      console.error("[MANUAL_ERP_CONSULTATION_FAILED]", {
        code: error.code,
        retryable: error.retryable,
        httpStatus: error.httpStatus ?? null
      });
      return fail("EXTERNAL_API_ERROR", error.message, status);
    }

    console.error("[MANUAL_ERP_CONSULTATION_FAILED]", {
      code: "UNKNOWN",
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("EXTERNAL_API_ERROR", "Falha ao consultar mensalidades.", 502);
  }
}
