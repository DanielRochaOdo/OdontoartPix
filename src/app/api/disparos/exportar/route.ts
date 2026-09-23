import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getDispatchList, getDispatchFilterOptions, normalizeDispatchFilters } from "@/lib/dispatches";
import { DispatchFiltersSchema } from "@/lib/dispatches-filter-schema";
import { buildDispatchesWorkbook, type DispatchesExportFilter } from "@/lib/dispatches-workbook";
import { fail } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ filters: DispatchFiltersSchema.default({}) });

function formatDate(value: string | null | undefined) {
  if (!value) return "";
  const br = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (br) return br[1].padStart(2, "0") + "/" + br[2].padStart(2, "0") + "/" + br[3];
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[3] + "/" + iso[2] + "/" + iso[1] : value;
}

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return fail("VALIDATION_ERROR", "Filtros de exportação inválidos.", 400);

  const filters = normalizeDispatchFilters(body.data.filters);
  try {
    // Exportação integral executada no servidor: nunca depende dos 50 itens visíveis.
    const [rows, options] = await Promise.all([getDispatchList(filters), getDispatchFilterOptions()]);
    const label = (name: "campaign" | "batch", selected: string[] | undefined) => {
      const lookup = new Map(options[name].map((option) => [option.value, option.label]));
      return selected?.length ? selected.map((id) => lookup.get(id) ?? id).join(", ") : "Todos";
    };
    const meta: DispatchesExportFilter[] = [
      { label: "Pesquisa geral", value: filters.query || "Todos" },
      { label: "Código associado", value: filters.code || "Todos" },
      { label: "Parcela", value: filters.installment || "Todas" },
      { label: "Data de vencimento", value: [filters.dueDateFrom, filters.dueDateTo].filter(Boolean).join(" até ") || "Todos" },
      { label: "Data de pagamento", value: [filters.paymentDateFrom, filters.paymentDateTo].filter(Boolean).join(" até ") || "Todos" },
      { label: "Status", value: filters.status?.join(", ") || "Todos" },
      { label: "Pagamento", value: filters.payment?.join(", ") || "Todos" },
      { label: "Pago com pendência", value: filters.paidPending === "yes" ? "Sim" : filters.paidPending === "no" ? "Não" : "Todos" },
      { label: "Tipo de pagamento", value: filters.receipt?.join(", ") || "Todos" },
      { label: "Tipo de parcela", value: filters.installmentType?.join(", ") || "Todos" },
      { label: "Campanha", value: label("campaign", filters.campaign) },
      { label: "Lote", value: label("batch", filters.batch) },
      { label: "Qtde disparos", value: filters.dispatchCount || "Todos" },
      { label: "Último disparo", value: [filters.lastDispatchFrom, filters.lastDispatchTo].filter(Boolean).join(" até ") || "Todos" }
    ];
    const workbook = buildDispatchesWorkbook({
      filters: meta,
      rows: rows.map((item) => ({
        name: item.member.name ?? "Sem nome",
        associatedCode: item.member.external_user_code ?? "",
        installment: item.target_installment_id ?? "",
        dueDate: formatDate(item.due_date_text),
        cpf: item.member.cpf ? "***.***.***-" + item.member.cpf.slice(-2) : "",
        campaign: item.campaign.name,
        batch: item.batch.name,
        status: item.processing_status,
        payment: item.payment_status === "paid" && item.total_pending_amount_cents > 0
          ? "Pago com pendência" : item.payment_status ?? "-",
        receiptDescription: item.payment_status === "agreed" ? "-" : item.payment_description?.trim() || "-",
        installmentType: item.installment_type ?? "",
        paymentDate: formatDate(item.payment_date_text),
        amountCents: item.installment_amount_cents,
        paidAmountCents: item.payment_amount_cents,
        pendingCents: item.total_pending_amount_cents,
        dispatchCount: item.dispatch_count,
        lastDispatchDate: formatDate(item.last_dispatch_date)
      }))
    });
    const XLSX = await import("xlsx-js-style");
    const output = XLSX.write(workbook, { bookType: "xlsx", type: "buffer", cellStyles: true });
    const bytes = new Uint8Array(output);
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="disparos-filtrados.xlsx"',
        "Cache-Control": "no-store",
        "X-Exported-Records": String(rows.length)
      }
    });
  } catch (error) {
    console.error("[DISPATCH_EXPORT_FAILED]", { message: error instanceof Error ? error.message : "Erro desconhecido" });
    return fail("EXPORT_ERROR", "Não foi possível gerar a planilha completa de disparos.", 500);
  }
}
