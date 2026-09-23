import { dbQuery } from "@/lib/db/pool";
import { ASSOCIADOS_CARD_BASE_SQL, type AssociadoCardListItem } from "@/lib/associados-card-read";

export type AssociadosFilters = {
  query?: string;
  code?: string;
  installment?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  paymentDateFrom?: string;
  paymentDateTo?: string;
  status?: string[];
  payment?: string[];
  paidPending?: "all" | "yes" | "no";
  receipt?: string[];
  installmentType?: string[];
  campaign?: string[];
  batch?: string[];
};

export type AssociadosFilterOption = { value: string; label: string };
export type AssociadosFilterOptions = {
  status: AssociadosFilterOption[];
  payment: AssociadosFilterOption[];
  receipt: AssociadosFilterOption[];
  installmentType: AssociadosFilterOption[];
  campaign: AssociadosFilterOption[];
  batch: AssociadosFilterOption[];
};
export type AssociadosPage = {
  rows: AssociadoCardListItem[];
  totalCount: number;
  filteredCount: number;
};

export type AssociadosSortKey =
  | "name" | "associatedCode" | "installment" | "dueDate" | "campaign"
  | "batch" | "status" | "payment" | "pending";

const PAGE_SIZE = 50;
const SORT_SQL: Record<AssociadosSortKey, string> = {
  name: "lower(coalesce(member_name, ''))",
  associatedCode: "lower(coalesce(external_user_code, ''))",
  installment: "lower(coalesce(target_installment_id, ''))",
  dueDate: "due_date",
  campaign: "lower(coalesce(campaign_name, ''))",
  batch: "lower(coalesce(batch_name, ''))",
  status: "status_key",
  payment: "payment_key",
  pending: "total_pending_amount_cents"
};

function filterValues(filters: AssociadosFilters) {
  const list = (values: string[] | undefined) => [...new Set((values ?? []).filter(Boolean))];
  const scalar = (value: string | undefined) => value?.trim() || null;
  return [
    list(filters.campaign), list(filters.batch), null,
    scalar(filters.query), scalar(filters.code), scalar(filters.installment),
    scalar(filters.dueDateFrom), scalar(filters.dueDateTo),
    scalar(filters.paymentDateFrom), scalar(filters.paymentDateTo),
    list(filters.status), list(filters.payment), filters.paidPending ?? "all",
    list(filters.receipt), list(filters.installmentType)
  ];
}

type CardRow = {
  id: string;
  campaign_id: string;
  batch_id: string;
  target_installment_id: string | null;
  installment_type: string | null;
  due_date_text: string | null;
  processing_status: string;
  payment_status: string | null;
  payment_description: string | null;
  payment_date_text: string | null;
  installment_amount_cents: number;
  payment_amount_cents: number | null;
  total_pending_amount_cents: number;
  last_error: string | null;
  cpf: string | null;
  member_name: string | null;
  external_user_code: string | null;
  batch_name: string;
  campaign_name: string;
};

function toCards(rows: CardRow[]): AssociadoCardListItem[] {
  return rows.map((row) => ({
    id: row.id,
    campaign_id: row.campaign_id,
    batch_id: row.batch_id,
    target_installment_id: row.target_installment_id,
    installment_type: row.installment_type,
    due_date_text: row.due_date_text,
    processing_status: row.processing_status,
    payment_status: row.payment_status,
    payment_description: row.payment_description,
    payment_date_text: row.payment_date_text,
    installment_amount_cents: Number(row.installment_amount_cents ?? 0),
    payment_amount_cents: row.payment_amount_cents == null ? null : Number(row.payment_amount_cents),
    total_pending_amount_cents: Number(row.total_pending_amount_cents ?? 0),
    last_error: row.last_error,
    member: {
      cpf: row.cpf,
      name: row.member_name,
      external_user_code: row.external_user_code
    },
    batch: { name: row.batch_name },
    campaign: { name: row.campaign_name }
  }));
}

function orderSql(sort: AssociadosSortKey, ascending: boolean) {
  const expression = SORT_SQL[sort] ?? SORT_SQL.name;
  return " order by " + expression + (ascending ? " asc" : " desc") + " nulls last, id asc";
}


const FILTERED_SQL = "with base as (" + ASSOCIADOS_CARD_BASE_SQL + ")" + ", normalized as (\n  select base.*,\n    case lower(trim(coalesce(processing_status, '')))\n      when 'pendente' then 'pending'\n      when 'processando' then 'processing'\n      when 'concluido' then 'completed'\n      when 'erro' then 'error'\n      when 'falhou' then 'failed'\n      when 'retry' then 'retrying'\n      else coalesce(nullif(lower(trim(processing_status)), ''), '-')\n    end as status_key,\n    case lower(trim(coalesce(payment_status, '')))\n      when 'pago' then 'paid'\n      when 'nao pago' then 'unpaid'\n      when 'acordado' then 'agreed'\n      when 'excluida' then 'excluded'\n      when 'pendente' then 'pending'\n      else coalesce(nullif(lower(trim(payment_status)), ''), '-')\n    end as payment_key,\n    case when payment_status = 'agreed' then '-'\n      else coalesce(nullif(trim(payment_description), ''), '-')\n    end as receipt_key,\n    case lower(trim(coalesce(installment_type, '')))\n      when 'clinico' then 'Clínico'\n      when 'orto' then 'Orto'\n      else '-'\n    end as installment_type_label,\n    case\n      when trim(coalesce(due_date_text, '')) ~ '^\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}$'\n        then to_date(trim(due_date_text), 'DD/MM/YYYY')\n      when trim(coalesce(due_date_text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}'\n        then to_date(substring(trim(due_date_text) from 1 for 10), 'YYYY-MM-DD')\n      when trim(coalesce(due_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{2}$'\n        then to_date(trim(due_date_text), 'MM/DD/YY')\n      else null\n    end as due_date,\n    case\n      when trim(coalesce(payment_date_text, '')) ~ '^\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}$'\n        then to_date(trim(payment_date_text), 'DD/MM/YYYY')\n      when trim(coalesce(payment_date_text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}'\n        then to_date(substring(trim(payment_date_text) from 1 for 10), 'YYYY-MM-DD')\n      when trim(coalesce(payment_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{2}$'\n        then to_date(trim(payment_date_text), 'MM/DD/YY')\n      else null\n    end as payment_date\n  from base\n), filtered as (\n  select *\n    from normalized\n   where ($4::text is null or position(lower($4::text) in lower(concat_ws(' ',\n     member_name, cpf, external_user_code, target_installment_id,\n     installment_type_label, to_char(due_date, 'DD/MM/YYYY'), campaign_name,\n     batch_name, status_key, payment_key,\n     case when payment_key = 'paid' and total_pending_amount_cents > 0 then 'pago com pendencia' else '' end,\n     receipt_key, to_char(payment_date, 'DD/MM/YYYY'),\n     case when status_key = 'error' and lower(coalesce(last_error, '')) like '%parcela alvo%'\n         and lower(coalesce(last_error, '')) like '%nao foi localizada%'\n       then 'parcela não encontrada' else '' end\n   ))) > 0)\n     and ($5::text is null or coalesce(external_user_code, '') = $5::text)\n     and ($6::text is null or coalesce(target_installment_id, '') = $6::text)\n     and ($7::date is null or due_date >= $7::date)\n     and ($8::date is null or due_date <= $8::date)\n     and ($9::date is null or payment_date >= $9::date)\n     and ($10::date is null or payment_date <= $10::date)\n     and (cardinality($11::text[]) = 0 or status_key = any($11::text[]))\n     and (cardinality($12::text[]) = 0 or payment_key = any($12::text[]))\n     and (\n       $13::text = 'all'\n       or ($13::text = 'yes' and payment_key = 'paid' and total_pending_amount_cents > 0)\n       or ($13::text = 'no' and not (payment_key = 'paid' and total_pending_amount_cents > 0))\n     )\n     and (cardinality($14::text[]) = 0 or receipt_key = any($14::text[]))\n     and (cardinality($15::text[]) = 0 or installment_type_label = any($15::text[]))\n)";

// A contagem geral não recebe filtros nem LIMIT e usa a mesma identidade
// financeira canônica da lista atual (uma parcela pode estar em vários lotes).
const GLOBAL_COUNT_SQL = `
  select count(distinct cbm.target_installment_ref_id)::int as total_count
    from campaign_batch_members cbm
    join campaigns c on c.id = cbm.campaign_id and c.deleted_at is null
    join campaign_batches b on b.id = cbm.batch_id and b.deleted_at is null
    join member_target_installments canonical on canonical.id = cbm.target_installment_ref_id
    join members m on m.id = canonical.member_id and m.deleted_at is null
   where cbm.deleted_at is null and cbm.target_installment_ref_id is not null
`;

export async function getAssociadosCardPage(
  filters: AssociadosFilters = {},
  page = 1,
  sort: AssociadosSortKey = "name",
  ascending = true
): Promise<AssociadosPage> {
  const safePage = Number.isSafeInteger(page) ? Math.min(Math.max(1, page), 100_000) : 1;
  const values = filterValues(filters);
  const [count, total, paged] = await Promise.all([
    dbQuery<{ filtered_count: number }>(FILTERED_SQL + " select count(*)::int as filtered_count from filtered", values),
    dbQuery<{ total_count: number }>(GLOBAL_COUNT_SQL),
    dbQuery<CardRow>(FILTERED_SQL + " select * from filtered" + orderSql(sort, ascending) +
      " limit $16 offset $17", [...values, PAGE_SIZE, (safePage - 1) * PAGE_SIZE])
  ]);
  return {
    rows: toCards(paged.rows),
    totalCount: Number(total.rows[0]?.total_count ?? 0),
    filteredCount: Number(count.rows[0]?.filtered_count ?? 0)
  };
}

// A exportação e as seleções explícitas consultam o mesmo conjunto filtrado,
// deliberadamente sem LIMIT e sem reutilizar a lista de 50 linhas do cliente.
export async function getAssociadosFilteredCards(
  filters: AssociadosFilters,
  sort: AssociadosSortKey = "name",
  ascending = true
): Promise<AssociadoCardListItem[]> {
  const result = await dbQuery<CardRow>(
    FILTERED_SQL + " select * from filtered" + orderSql(sort, ascending),
    filterValues(filters)
  );
  return toCards(result.rows);
}

export async function getAssociadosFilteredIds(filters: AssociadosFilters, max = 10_000) {
  const result = await dbQuery<{ id: string }>(
    FILTERED_SQL + " select id from filtered order by id limit $16",
    [...filterValues(filters), max + 1]
  );
  if (result.rows.length > max) {
    throw new Error("O resultado ultrapassa o limite de 10.000 registros da operação. Restrinja os filtros antes de prosseguir.");
  }
  return result.rows.map((row) => row.id);
}

export async function getAssociadosCardFilterOptions(): Promise<AssociadosFilterOptions> {
  const result = await dbQuery<{
    status: AssociadosFilterOption[];
    payment: AssociadosFilterOption[];
    receipt: AssociadosFilterOption[];
    installment_type: AssociadosFilterOption[];
    campaign: AssociadosFilterOption[];
    batch: AssociadosFilterOption[];
  }>("with base as (" + ASSOCIADOS_CARD_BASE_SQL + ") select " +
    "coalesce(jsonb_agg(distinct jsonb_build_object('value', coalesce(processing_status, '-'), 'label', coalesce(processing_status, '-'))), '[]'::jsonb) as status, " +
    "coalesce(jsonb_agg(distinct jsonb_build_object('value', coalesce(payment_status, '-'), 'label', coalesce(payment_status, '-'))), '[]'::jsonb) as payment, " +
    "coalesce(jsonb_agg(distinct jsonb_build_object('value', case when payment_status = 'agreed' then '-' else coalesce(nullif(trim(payment_description), ''), '-') end, 'label', case when payment_status = 'agreed' then '-' else coalesce(nullif(trim(payment_description), ''), '-') end)), '[]'::jsonb) as receipt, " +
    "coalesce(jsonb_agg(distinct jsonb_build_object('value', case lower(trim(coalesce(installment_type, ''))) when 'clinico' then 'Clínico' when 'orto' then 'Orto' else '-' end, 'label', case lower(trim(coalesce(installment_type, ''))) when 'clinico' then 'Clínico' when 'orto' then 'Orto' else '-' end)), '[]'::jsonb) as installment_type, " +
    "coalesce(jsonb_agg(distinct jsonb_build_object('value', campaign_id, 'label', campaign_name)), '[]'::jsonb) as campaign, " +
    "coalesce(jsonb_agg(distinct jsonb_build_object('value', batch_id, 'label', batch_name)), '[]'::jsonb) as batch " +
    "from base", [[], [], null]);
  const item = result.rows[0];
  const sort = (items: AssociadosFilterOption[] = []) => items.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  return {
    status: sort(item?.status),
    payment: sort(item?.payment),
    receipt: sort(item?.receipt),
    installmentType: sort(item?.installment_type),
    campaign: sort(item?.campaign),
    batch: sort(item?.batch)
  };
}
