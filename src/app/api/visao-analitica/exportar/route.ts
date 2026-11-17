import { requireApiUser } from "@/lib/auth/require-api-user";
import { getAnalyticsExportRows, readAnalyticsFilters } from "@/lib/analytics-payments";
import { fail } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const humanDate = (value: string | null) => value
  ? value.slice(8, 10) + "/" + value.slice(5, 7) + "/" + value.slice(0, 4) : "";
const punctuality = (days: number | null) => days == null ? "Indisponível"
  : days === 0 ? "No vencimento"
  : days < 0 ? Math.abs(days) + " dia(s) antes" : days + " dia(s) de atraso";
const hours = (key: string) => key === "unavailable" ? "Indisponível"
  : key === "between" ? "Entre faixas" : key.replace("-", "h–") + "h";

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const p = new URL(request.url).searchParams;
  const args: Record<string, string | string[]> = {};
  for (const key of p.keys()) {
    if (["status", "payment", "receipt", "installmentType", "campaign", "batch"].includes(key))
      args[key] = p.getAll(key);
    else args[key] = p.get(key) ?? "";
  }
  let filters;
  try {
    filters = readAnalyticsFilters(args);
  } catch {
    return fail("VALIDATION_ERROR", "Filtros inválidos.", 400);
  }

  try {
    const rows = await getAnalyticsExportRows(filters);
    const XLSX = await import("xlsx-js-style");
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Associado", "Código associado", "CPF", "Parcela", "Tipo de parcela",
        "Campanhas", "Lotes", "Vencimento", "Data do pagamento",
        "Faixa de horário", "Horário estimado", "Pontualidade",
        "Forma de recebimento", "Valor da parcela (R$)",
        "Valor recebido (R$)", "Valor pendente (R$)"],
      ...rows.map((row) => [
        row.memberName ?? "", row.associatedCode ?? "", row.cpf ?? "", row.installment,
        row.installmentType === "clinico" ? "Clínico" : row.installmentType === "orto" ? "Orto" : "",
        row.campaigns ?? "", row.batches ?? "",
        humanDate(row.dueDate), humanDate(row.paymentDate),
        hours(row.hourBucket), row.estimatedHour ?? "",
        punctuality(row.delayDays), row.paymentMethod ?? "",
        row.amountCents / 100, (row.paidAmountCents ?? 0) / 100, row.pendingAmountCents / 100
      ])
    ]);
    sheet["!cols"] = [28, 18, 19, 16, 17, 30, 30, 16, 20, 20, 20, 23, 31, 24, 24, 24]
      .map((wch) => ({ wch }));
    sheet["!autofilter"] = { ref: "A1:P" + (rows.length + 1) };
    for (let col = 13; col <= 15; col++) {
      for (let row = 2; row <= rows.length + 1; row++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row - 1, c: col })];
        if (cell) cell.z = '"R$" #,##0.00';
      }
    }
    XLSX.utils.book_append_sheet(book, sheet, "Pagamentos");
    const output = XLSX.write(book, { bookType: "xlsx", type: "buffer" });
    return new Response(new Uint8Array(output), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="visao-analitica-pagamentos.xlsx"',
        "Cache-Control": "no-store",
        "X-Exported-Records": String(rows.length)
      }
    });
  } catch (error) {
    console.error("[PAYMENT_ANALYTICS_EXPORT_FAILED]", error);
    if (error instanceof Error && error.message.startsWith("Limite de exportação")) {
      return fail("VALIDATION_ERROR", error.message, 400);
    }
    return fail("DATABASE_ERROR", "Não foi possível exportar os pagamentos.", 500);
  }
}
