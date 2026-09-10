import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail } from "@/lib/http/api-response";
import { validateSummaryAnalysisRange } from "@/lib/summary-analysis";
import { buildSummaryAnalysisPdf } from "@/lib/summary-analysis-pdf";

export const runtime = "nodejs";

const EntitySchema = z.object({
  dispatchCount: z.number().finite(),
  dispatchValueCents: z.number().finite(),
  actionCostCents: z.number().finite(),
  paidAssociateCount: z.number().finite(),
  paidInstallmentCount: z.number().finite(),
  paidAmountCents: z.number().finite(),
  paidAssociatePercentage: z.number().finite(),
  paidInstallmentPercentage: z.number().finite(),
  paidPercentage: z.number().finite(),
  netAmountCents: z.number().finite()
});

const PixEntitySchema = z.object({
  dispatchValueCents: z.number().finite(),
  paidAssociateCount: z.number().finite(),
  paidInstallmentCount: z.number().finite(),
  paidAmountCents: z.number().finite()
});

const FilterSchema = z.object({
  label: z.string().min(1).max(100),
  value: z.string().max(1000)
});

const BodySchema = z.object({
  from: z.string(),
  to: z.string(),
  paymentDateFrom: z.string(),
  paymentDateTo: z.string(),
  filters: z.array(FilterSchema).max(20),
  dispatchUnitCostCents: z.number().int().min(0),
  clinico: EntitySchema,
  orto: EntitySchema,
  combined: EntitySchema,
  robo: EntitySchema,
  roboClinico: PixEntitySchema,
  roboOrto: PixEntitySchema
});

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("VALIDATION_ERROR", "Dados invalidos para exportacao do PDF.", 400);

  try {
    validateSummaryAnalysisRange(parsed.data.from, parsed.data.to);
    validateSummaryAnalysisRange(parsed.data.paymentDateFrom, parsed.data.paymentDateTo);
    const pdf = buildSummaryAnalysisPdf({
      filters: parsed.data.filters,
      dispatchUnitCostCents: parsed.data.dispatchUnitCostCents,
      clinico: parsed.data.clinico,
      orto: parsed.data.orto,
      combined: parsed.data.combined,
      robo: parsed.data.robo,
      roboClinico: parsed.data.roboClinico,
      roboOrto: parsed.data.roboOrto
    });
    return new Response(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="resumo-analise.pdf"',
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return fail(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "Nao foi possivel gerar o PDF.",
      500
    );
  }
}
