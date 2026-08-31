import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";

const ParamsSchema = z.object({ requestId: z.string().uuid() });
const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

type ChangedRow = {
  member_id: string;
  member_name: string;
  associated_code: string | null;
  campaign_name: string;
  batch_name: string;
  previous_payment_status: string | null;
  payment_status: string | null;
  previous_installment_amount_cents: string | number | null;
  installment_amount_cents: string | number | null;
  previous_payment_amount_cents: string | number | null;
  payment_amount_cents: string | number | null;
  previous_total_pending_amount_cents: string | number | null;
  total_pending_amount_cents: string | number | null;
  previous_payment_description: string | null;
  payment_description: string | null;
  previous_payment_date_text: string | null;
  payment_date_text: string | null;
  total_count: number;
};

type FieldChange = {
  label: string;
  before: string;
  after: string;
};

type Formatter = (value: unknown) => string;

function normalizeNullable(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function displayText(value: unknown) {
  return normalizeNullable(value) ?? "—";
}

function displayMoney(value: unknown) {
  if (value == null || value === "") return "—";
  const cents = Number(value);
  if (!Number.isFinite(cents)) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(cents / 100);
}

function displayPaymentStatus(value: unknown) {
  const normalized = normalizeNullable(value)?.toLowerCase();
  if (!normalized) return "—";
  if (normalized === "paid") return "Pago";
  if (normalized === "unpaid") return "Não pago";
  if (normalized === "agreed") return "Acordado";
  if (normalized === "pending") return "Pendente";
  return displayText(value);
}

function pushChange(
  changes: FieldChange[],
  label: string,
  before: unknown,
  after: unknown,
  formatter: Formatter = displayText
) {
  if (normalizeNullable(before) === normalizeNullable(after)) return;
  changes.push({
    label,
    before: formatter(before),
    after: formatter(after)
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) return fail("VALIDATION_ERROR", "Processamento manual inválido.", 400);

  const url = new URL(request.url);
  const parsedQuery = QuerySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined
  });
  if (!parsedQuery.success) return fail("VALIDATION_ERROR", "Paginação inválida.", 400);

  const { page, pageSize } = parsedQuery.data;
  const offset = (page - 1) * pageSize;

  try {
    const result = await dbQuery<ChangedRow>(
      `select
         i.member_link_id::text as member_id,
         coalesce(m.name, 'Sem nome') as member_name,
         m.external_user_code::text as associated_code,
         coalesce(c.name, '-') as campaign_name,
         coalesce(b.name, '-') as batch_name,
         i.previous_payment_status,
         cbm.payment_status,
         i.previous_installment_amount_cents,
         cbm.installment_amount_cents,
         i.previous_payment_amount_cents,
         cbm.payment_amount_cents,
         i.previous_total_pending_amount_cents,
         cbm.total_pending_amount_cents,
         i.previous_payment_description,
         cbm.payment_description,
         i.previous_payment_date_text,
         cbm.payment_date_text,
         count(*) over()::int as total_count
       from associados_processing_items i
       join processing_jobs pj on pj.id = i.processing_job_id
       join campaign_batch_members cbm on cbm.id = i.member_link_id
       join members m on m.id = cbm.member_id
       join campaigns c on c.id = i.campaign_id
       join campaign_batches b on b.id = i.batch_id
      where i.request_id = $1::uuid
        and i.financial_snapshot_complete
        and pj.success_items > 0
        and (
          cbm.payment_status is distinct from i.previous_payment_status
          or cbm.installment_amount_cents is distinct from i.previous_installment_amount_cents
          or cbm.payment_amount_cents is distinct from i.previous_payment_amount_cents
          or cbm.total_pending_amount_cents is distinct from i.previous_total_pending_amount_cents
          or cbm.payment_description is distinct from i.previous_payment_description
          or cbm.payment_date_text is distinct from i.previous_payment_date_text
        )
      order by m.name, m.external_user_code, i.member_link_id
      limit $2 offset $3`,
      [parsedParams.data.requestId, pageSize, offset]
    );

    const total = Number(result.rows[0]?.total_count ?? 0);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));

    return ok({
      requestId: parsedParams.data.requestId,
      total,
      page,
      pageSize,
      pageCount,
      items: result.rows.map((row) => {
        const fields: FieldChange[] = [];
        pushChange(fields, "Status do pagamento", row.previous_payment_status, row.payment_status, displayPaymentStatus);
        pushChange(fields, "Valor da parcela", row.previous_installment_amount_cents, row.installment_amount_cents, displayMoney);
        pushChange(fields, "Valor pago", row.previous_payment_amount_cents, row.payment_amount_cents, displayMoney);
        pushChange(fields, "Pendência", row.previous_total_pending_amount_cents, row.total_pending_amount_cents, displayMoney);
        pushChange(fields, "Tipo de pagamento", row.previous_payment_description, row.payment_description);
        pushChange(fields, "Data de pagamento", row.previous_payment_date_text, row.payment_date_text);

        return {
          memberId: row.member_id,
          memberName: row.member_name,
          associatedCode: row.associated_code,
          campaignName: row.campaign_name,
          batchName: row.batch_name,
          fields
        };
      })
    });
  } catch (error) {
    console.error("[ASSOCIADOS_PROCESSING_CHANGES_FAILED]", {
      requestId: parsedParams.data.requestId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível carregar as alterações encontradas.", 500);
  }
}
