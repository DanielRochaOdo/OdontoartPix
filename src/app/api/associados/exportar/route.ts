import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getAssociadosFilteredCards, getAssociadosCardFilterOptions } from "@/lib/associados-paginated";
import { AssociadosFiltersSchema, AssociadosSortSchema } from "@/lib/associados-filter-schema";
import { buildAssociadosWorkbook } from "@/lib/export-workbooks";
import { isMissingTargetInstallmentError, INSTALLMENT_NOT_FOUND_LABEL } from "@/lib/processing-errors";
import { fail } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  filters: AssociadosFiltersSchema.default({}),
  sort: AssociadosSortSchema.default("name"),
  ascending: z.boolean().default(true)
});

function displayDate(value: string | null | undefined) {
  if (!value?.trim()) return "";
  const br = value.trim().match(/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/);
  if (br) return value.replace(/-/g, "/");
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[3] + "/" + iso[2] + "/" + iso[1];
  const american = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (american) return american[2].padStart(2, "0") + "/" + american[1].padStart(2, "0") + "/20" + american[3];
  return value.trim();
}

const STATUS: Record<string, string> = {
  pending: "Pendente", processing: "Processando", completed: "Concluído",
  error: "Erro", failed: "Falhou", retrying: "Tentando novamente", aguardando: "Aguardando"
};
const PAYMENT: Record<string, string> = {
  paid: "Pago", unpaid: "Não pago", agreed: "Acordado", excluded: "Excluída", pending: "Pendente"
};
const TYPE: Record<string, string> = { clinico: "Clínico", orto: "Orto" };

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("VALIDATION_ERROR", "Filtros inválidos para exportação.", 400);

  const { filters, sort, ascending } = parsed.data;
  try {
    // A planilha é construída com todos os resultados filtrados, nunca com os 50 exibidos.
    const [rows, options] = await Promise.all([
      getAssociadosFilteredCards(filters, sort, ascending),
      getAssociadosCardFilterOptions()
    ]);
    const labels = (kind: "campaign" | "batch", values: string[] | undefined) => {
      const lookup = new Map(options[kind].map((option) => [option.value, option.label]));
      return values?.length ? values.map((id) => lookup.get(id) ?? id).join(", ") : "Todos";
    };
    const workbook = buildAssociadosWorkbook({
      filters: [
        { label: "Pesquisa geral", value: filters.query?.trim() || "Todos" },
        { label: "Código associado", value: filters.code?.trim() || "Todos" },
        { label: "Parcela", value: filters.installment?.trim() || "Todas" },
        { label: "Data de vencimento", value: [filters.dueDateFrom, filters.dueDateTo].filter(Boolean).join(" até ") || "Todos os vencimentos" },
        { label: "Data de pagamento", value: [filters.paymentDateFrom, filters.paymentDateTo].filter(Boolean).join(" até ") || "Todas as datas" },
        { label: "Status", value: filters.status?.map((status) => STATUS[status] ?? status).join(", ") || "Todos" },
        { label: "Pagamento", value: filters.payment?.map((payment) => PAYMENT[payment] ?? payment).join(", ") || "Todos" },
        { label: "Pago com pendência", value: filters.paidPending === "yes" ? "Sim" : filters.paidPending === "no" ? "Não" : "Todos" },
        { label: "Tipo de pagamento", value: filters.receipt?.join(", ") || "Todos" },
        { label: "Tipo de parcela", value: filters.installmentType?.join(", ") || "Todos" },
        { label: "Campanha", value: labels("campaign", filters.campaign) },
        { label: "Lote", value: labels("batch", filters.batch) }
      ],
      rows: rows.map((item) => {
        const payment = item.payment_status ?? "-";
        const pending = Number(item.total_pending_amount_cents ?? 0);
        const missingInstallment = isMissingTargetInstallmentError({
          processingStatus: item.processing_status,
          lastError: item.last_error
        });
        return {
          name: item.member?.name ?? "Sem nome",
          associatedCode: item.member?.external_user_code ?? "",
          installment: item.target_installment_id ?? "",
          dueDate: displayDate(item.due_date_text),
          cpf: item.member?.cpf ? "***.***.***-" + item.member.cpf.slice(-2) : "",
          campaign: item.campaign?.name ?? "-",
          batch: item.batch?.name ?? "-",
          status: missingInstallment ? "Erro — " + INSTALLMENT_NOT_FOUND_LABEL :
            STATUS[item.processing_status] ?? item.processing_status,
          payment: payment === "paid" && pending > 0 ? "Pago com pendência" : PAYMENT[payment] ?? payment,
          receiptDescription: payment === "agreed" ? "-" : item.payment_description?.trim() || "-",
          installmentType: TYPE[item.installment_type ?? ""] ?? "",
          paymentDate: displayDate(item.payment_date_text),
          amountCents: Number(item.installment_amount_cents ?? 0),
          paidAmountCents: item.payment_amount_cents,
          pendingCents: pending
        };
      })
    });
    const XLSX = await import("xlsx-js-style");
    const output = XLSX.write(workbook, { bookType: "xlsx", type: "buffer", cellStyles: true });
    return new Response(new Uint8Array(output), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="associados-filtrados.xlsx"',
        "Cache-Control": "no-store",
        "X-Exported-Records": String(rows.length)
      }
    });
  } catch (error) {
    console.error("[ASSOCIADOS_EXPORT_FAILED]", { message: error instanceof Error ? error.message : "Erro desconhecido" });
    return fail("DATABASE_ERROR", "Não foi possível gerar a planilha completa de associados.", 500);
  }
}
