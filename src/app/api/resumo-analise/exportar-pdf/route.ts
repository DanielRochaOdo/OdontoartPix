import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail } from "@/lib/http/api-response";
import { validateSummaryAnalysisRange } from "@/lib/summary-analysis";

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

const BodySchema = z.object({
  from: z.string(),
  to: z.string(),
  dispatchUnitCostCents: z.number().int().min(0),
  clinico: EntitySchema,
  orto: EntitySchema,
  combined: EntitySchema,
  robo: z.object({
    paidAssociateCount: z.number().finite(),
    paidInstallmentCount: z.number().finite(),
    paidAmountCents: z.number().finite()
  })
});

function ascii(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?");
}

function escapePdf(value: string) {
  return ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function currency(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function count(value: number) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function percentage(value: number) {
  return `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}%`;
}

function displayDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function buildPdf(lines: Array<{ text: string; size?: number; gap?: number }>) {
  let y = 800;
  const commands: string[] = ["BT"];
  for (const line of lines) {
    const size = line.size ?? 10;
    commands.push(`/F1 ${size} Tf`);
    commands.push(`1 0 0 1 50 ${y} Tm`);
    commands.push(`(${escapePdf(line.text)}) Tj`);
    y -= line.gap ?? (size >= 14 ? 24 : 17);
  }
  commands.push("ET");
  const stream = commands.join("\n") + "\n";

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf, "ascii");
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

function entityLines(title: string, entity: z.infer<typeof EntitySchema>) {
  return [
    { text: title, size: 13, gap: 20 },
    { text: `Qtde disparos: ${count(entity.dispatchCount)} | Valor disparos: ${currency(entity.dispatchValueCents)} | Custo acao: ${currency(entity.actionCostCents)}` },
    { text: `Assoc. pagos: ${count(entity.paidAssociateCount)} (${percentage(entity.paidAssociatePercentage)}) | Parcelas pagas: ${count(entity.paidInstallmentCount)} (${percentage(entity.paidInstallmentPercentage)})` },
    { text: `Pago: ${currency(entity.paidAmountCents)} | % pago: ${percentage(entity.paidPercentage)} | Liquido: ${currency(entity.netAmountCents)}`, gap: 22 }
  ];
}

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("VALIDATION_ERROR", "Dados invalidos para exportacao do PDF.", 400);

  try {
    validateSummaryAnalysisRange(parsed.data.from, parsed.data.to);
    const lines = [
      { text: "Resumo e Analise", size: 18, gap: 28 },
      { text: `Periodo: ${displayDate(parsed.data.from)} a ${displayDate(parsed.data.to)}` },
      { text: `Custo unitario por disparo: ${currency(parsed.data.dispatchUnitCostCents)}`, gap: 24 },
      ...entityLines("Clinico", parsed.data.clinico),
      ...entityLines("Orto", parsed.data.orto),
      ...entityLines("Clinico + Orto", parsed.data.combined),
      { text: "Robo - resultados via PIX", size: 13, gap: 20 },
      { text: `Associados PIX: ${count(parsed.data.robo.paidAssociateCount)} | Pagamentos PIX: ${count(parsed.data.robo.paidInstallmentCount)}` },
      { text: `Valor recebido via PIX: ${currency(parsed.data.robo.paidAmountCents)}` }
    ];
    const pdf = buildPdf(lines);
    return new Response(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="resumo-analise-${parsed.data.from}-a-${parsed.data.to}.pdf"`,
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
