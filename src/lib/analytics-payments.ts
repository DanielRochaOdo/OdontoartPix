import { dbQuery } from "@/lib/db/pool";
import type { AnalyticsPerfTrace } from "@/lib/analytics-performance";
import type { AssociadosFilters } from "@/lib/associados-paginated";

export { ANALYTIC_HOURS } from "@/lib/analytics-hour-buckets";
import { ANALYTIC_HOURS } from "@/lib/analytics-hour-buckets";
export type { AnalyticHour } from "@/lib/analytics-hour-buckets";
export type AnalyticPunctuality = "all" | "early" | "on-time" | "late" | "unavailable";

export type AnalyticsFilters = AssociadosFilters & {
  from: string;
  to: string;
  hour: string;
  weekday: string;
  punctuality: AnalyticPunctuality;
  amountMin: string;
  amountMax: string;
  page: number;
  tab: "panorama" | "horarios" | "comportamento" | "comparativos" | "faturas";
};

const listKeys = ["status", "payment", "receipt", "installmentType", "campaign", "batch"] as const;
const textKeys = [
  "query", "code", "installment", "dueDateFrom", "dueDateTo",
  "paymentDateFrom", "paymentDateTo", "amountMin", "amountMax"
] as const;
const dateKeys = ["from", "to", "dueDateFrom", "dueDateTo", "paymentDateFrom", "paymentDateTo"] as const;
const isoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;

export function readAnalyticsFilters(params: Record<string, string | string[] | undefined>, now = new Date()): AnalyticsFilters {
  const single = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  };
  const values = (key: string) => {
    const value = params[key];
    return [...new Set((Array.isArray(value) ? value : value ? [value] : [])
      .map((item) => item.trim()).filter(Boolean))];
  };
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
  const from = single("from") || today.slice(0, 7) + "-01";
  const to = single("to") || today;
  const dates = { from, to, ...Object.fromEntries(dateKeys.slice(2).map((key) => [key, single(key)])) };
  for (const [key, value] of Object.entries(dates)) {
    if (value && !isoDate(value)) throw new Error("Data inválida: " + key);
  }
  if (from > to) throw new Error("O período inicial deve ser anterior ao final.");
  if (single("dueDateFrom") && single("dueDateTo") && single("dueDateFrom") > single("dueDateTo")) throw new Error("Vencimentos inválidos.");
  if (single("paymentDateFrom") && single("paymentDateTo") && single("paymentDateFrom") > single("paymentDateTo")) throw new Error("Datas de pagamento inválidas.");
  const hour = single("hour") || "all";
  if (!["all", ...ANALYTIC_HOURS, "between", "unavailable"].includes(hour)) throw new Error("Faixa de horário inválida.");
  const weekday = single("weekday") || "all";
  if (!["all", "1", "2", "3", "4", "5", "6", "7"].includes(weekday)) throw new Error("Dia da semana inválido.");
  const punctuality = single("punctuality") || "all";
  if (!["all", "early", "on-time", "late", "unavailable"].includes(punctuality)) throw new Error("Pontualidade inválida.");
  const amountMin = single("amountMin"), amountMax = single("amountMax");
  for (const value of [amountMin, amountMax]) {
    if (value && (!/^\d+(?:[.,]\d{1,2})?$/.test(value) || Number(value.replace(",", ".")) > 1e9))
      throw new Error("Valor financeiro inválido.");
  }
  const page = Math.max(1, Math.min(100000, Number.parseInt(single("page"), 10) || 1));
  const raw: AnalyticsFilters = {
    from, to, hour, weekday, punctuality: punctuality as AnalyticPunctuality, amountMin, amountMax, page,
    tab: (["panorama", "horarios", "comportamento", "comparativos", "faturas"].includes(single("tab"))
      ? single("tab") : "panorama") as AnalyticsFilters["tab"],
    query: "", code: "", installment: "", dueDateFrom: "", dueDateTo: "",
    paymentDateFrom: "", paymentDateTo: "",
    status: [], payment: [], paidPending: "all", receipt: [], installmentType: [],
    campaign: [], batch: []
  };
  for (const key of textKeys) {
    if (key !== "amountMin" && key !== "amountMax") (raw as unknown as Record<string, unknown>)[key] = single(key).slice(0, 150);
  }
  for (const key of listKeys) (raw as unknown as Record<string, unknown>)[key] = values(key).slice(0, 100);
  const paidPending = single("paidPending");
  raw.paidPending = paidPending === "yes" || paidPending === "no" ? paidPending : "all";
  for (const key of ["campaign", "batch"] as const) {
    if (raw[key]!.some((id) => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))) {
      throw new Error("Filtro de campanha ou lote inválido.");
    }
  }
  return raw;
}

export function analyticsSearch(filters: AnalyticsFilters, changes: Record<string, string | number | null> = {}) {
  const p = new URLSearchParams();
  for (const key of ["from", "to", "hour", "weekday", "punctuality", "amountMin", "amountMax",
    "query", "code", "installment", "dueDateFrom", "dueDateTo",
    "paymentDateFrom", "paymentDateTo", "paidPending"] as const) {
    const value = filters[key];
    if (value && value !== "all") p.set(key, value);
  }
  for (const key of listKeys) for (const value of filters[key] ?? []) p.append(key, value);
  if (filters.page !== 1) p.set("page", String(filters.page));
  if (filters.tab !== "panorama") p.set("tab", filters.tab);
  for (const [key, value] of Object.entries(changes)) {
    p.delete(key);
    if (value != null && String(value)) p.set(key, String(value));
  }
  return p.toString();
}

function dateSql(column: string) {
  return `case
    when btrim(coalesce(${column}, '')) ~ '^\\d{4}-\\d{2}-\\d{2}$'
      then to_date(btrim(${column}), 'YYYY-MM-DD')
    when btrim(coalesce(${column}, '')) ~ '^\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}$'
      then to_date(replace(btrim(${column}), '-', '/'), 'DD/MM/YYYY')
    when btrim(coalesce(${column}, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{2}$'
      then to_date(btrim(${column}), 'MM/DD/YY')
    else null::date end`;
}

const hourBucketSql = (stamp: string) => `lpad(((extract(hour from (${stamp} at time zone 'America/Fortaleza'))::int / 2) * 2)::text, 2, '0') || '-' ||
  lpad(((((extract(hour from (${stamp} at time zone 'America/Fortaleza'))::int / 2) * 2) + 2) % 24)::text, 2, '0')`;

/** A MESMA unidade do Dashboard: uma target canonica, independente de quantos vinculos ela possua.
 * Filtros de vinculos sao aplicados ANTES do agrupamento, sem multiplicar a target.
 */
export const ANALYTICS_BASE_SQL = `with scoped_links as (
  select l.target_installment_ref_id, l.campaign_id, l.batch_id, l.processing_status,
         c.name as campaign_name, b.name as batch_name
  from campaign_batch_members l
  join campaigns c on c.id = l.campaign_id and c.deleted_at is null
  join campaign_batches b on b.id = l.batch_id and b.deleted_at is null
  where l.deleted_at is null and l.target_installment_ref_id is not null
    and (cardinality($1::uuid[]) = 0 or l.campaign_id = any($1::uuid[]))
    and (cardinality($2::uuid[]) = 0 or l.batch_id = any($2::uuid[]))
), linked as (
  select target_installment_ref_id,
         string_agg(distinct campaign_name, ', ' order by campaign_name) as campaigns,
         string_agg(distinct batch_name, ', ' order by batch_name) as batches,
         case
           when bool_or(processing_status = 'error') then 'error'
           when bool_or(processing_status = 'processing') then 'processing'
           when bool_or(processing_status = 'retrying') then 'retrying'
           when bool_and(processing_status = 'completed') then 'completed'
           else 'pending' end as processing_status
  from scoped_links
  group by target_installment_ref_id
), paid_targets as (
  select t.id, t.member_id, t.external_installment_code, t.installment_type,
         t.due_date_text, t.payment_date_text, t.payment_description,
         t.payment_status, t.amount_cents, t.paid_amount_cents, t.pending_amount_cents,
         t.financial_observed_at, t.last_erp_status_at,
         m.name as member_name, m.cpf, m.external_user_code,
         linked.campaigns, linked.batches, linked.processing_status,
         o.last_unpaid_at, o.first_paid_at
  from linked
  join member_target_installments t on t.id = linked.target_installment_ref_id
  left join members m on m.id = t.member_id
  left join payment_hour_observations o on o.target_installment_id = t.id
  where t.payment_status = 'paid'
), dated as (
  select *,
         ${dateSql("due_date_text")} as due_date,
         ${dateSql("payment_date_text")} as payment_date
  from paid_targets
), with_hours as (
  select *,
    case when first_paid_at is not null and last_unpaid_at is not null
          and first_paid_at >= last_unpaid_at
          and payment_date = (first_paid_at at time zone 'America/Fortaleza')::date
          and payment_date = (last_unpaid_at at time zone 'America/Fortaleza')::date
        then last_unpaid_at else null end as window_start,
    case when first_paid_at is not null and last_unpaid_at is not null
          and first_paid_at >= last_unpaid_at
          and payment_date = (first_paid_at at time zone 'America/Fortaleza')::date
          and payment_date = (last_unpaid_at at time zone 'America/Fortaleza')::date
        then first_paid_at else null end as window_end,
    -- Historico: o horario de deteccao vem da consulta financeira ao ERP,
    -- nunca de created_at/updated_at de snapshots operacionais.
    -- Ambas as evidencias canonicas devem coincidir com a data paga do ERP.
    case when last_erp_status_at is not null and financial_observed_at is not null
          and payment_date = (last_erp_status_at at time zone 'America/Fortaleza')::date
          and payment_date = (financial_observed_at at time zone 'America/Fortaleza')::date
        then last_erp_status_at else null end as detected_at
  from dated
), classified as (
  select *,
    (payment_date - due_date)::int as delay_days,
    case when due_date is null or payment_date is null then 'unavailable'
         when payment_date < due_date then 'early'
         when payment_date = due_date then 'on-time'
         else 'late' end as punctuality,
    case
      when window_start is not null and window_end is not null then
        case when ${hourBucketSql("window_start")} = ${hourBucketSql("window_end")}
             then ${hourBucketSql("window_end")} else 'between' end
      when detected_at is not null then ${hourBucketSql("detected_at")}
      else 'unavailable' end as hour_bucket,
    case when window_start is not null then
        to_char(window_start at time zone 'America/Fortaleza', 'HH24:MI') || '–' ||
        to_char(window_end at time zone 'America/Fortaleza', 'HH24:MI')
      when detected_at is not null then
        to_char(detected_at at time zone 'America/Fortaleza', 'HH24:MI')
      else null end as estimated_hour,
    case when window_start is not null and window_end is not null then 'observed-window'
         when detected_at is not null then 'erp-detection'
         else 'unavailable' end as hour_source
  from with_hours
), filtered as (
  select * from classified
  where ($3::text = '' or position(lower($3::text) in lower(concat_ws(' ',
      member_name, cpf, external_user_code, external_installment_code, campaigns,
      batches, payment_description))) > 0)
    and ($4::text = '' or coalesce(external_user_code, '') = $4::text)
    and ($5::text = '' or external_installment_code = $5::text)
    and ($6::date is null or due_date >= $6::date)
    and ($7::date is null or due_date <= $7::date)
    and ($8::date is null or payment_date >= $8::date)
    and ($9::date is null or payment_date <= $9::date)
    and (cardinality($10::text[]) = 0 or processing_status = any($10::text[]))
    and (cardinality($11::text[]) = 0 or payment_status = any($11::text[]))
    and ($12::text = 'all' or
      ($12::text = 'yes' and pending_amount_cents > 0) or
      ($12::text = 'no' and coalesce(pending_amount_cents, 0) <= 0))
    and (cardinality($13::text[]) = 0 or coalesce(nullif(btrim(payment_description), ''), '-') = any($13::text[]))
    and (cardinality($14::text[]) = 0 or
      case installment_type when 'clinico' then 'Clínico'
                            when 'orto' then 'Orto' else '-' end = any($14::text[]))
    and ($15::date is null or payment_date >= $15::date)
    and ($16::date is null or payment_date <= $16::date)
    and ($17::text = 'all' or hour_bucket = $17::text)
    and ($18::text = 'all' or punctuality = $18::text)
    and ($19::numeric is null or paid_amount_cents >= $19::numeric)
    and ($20::numeric is null or paid_amount_cents <= $20::numeric)
    and ($21::text = 'all' or extract(isodow from payment_date)::int::text = $21::text)
)`;

const METRICS_SQL = ANALYTICS_BASE_SQL + `
select
  count(*)::int as "installmentCount",
  count(distinct member_id)::int as "memberCount",
  coalesce(sum(paid_amount_cents), 0)::float8 as "paidAmountCents",
  coalesce(sum(paid_amount_cents), 0)::float8 / nullif(count(*), 0) as "averageTicketCents",
  count(*) filter (where punctuality in ('early', 'on-time'))::int as "onTimeCount",
  count(*) filter (where punctuality = 'late')::int as "lateCount",
  count(*) filter (where punctuality = 'unavailable')::int as "punctualityUnavailable",
  round(avg(delay_days) filter (where delay_days > 0), 2)::float8 as "averageLateDays",
  count(*) filter (where hour_bucket = 'unavailable')::int as "hourUnavailable",
  count(*) filter (where hour_bucket = 'between')::int as "hourBetween"
from filtered`;

const GROUP_SQL = ANALYTICS_BASE_SQL + `
select kind, key, count(*)::int as count,
       coalesce(sum(paid_amount_cents), 0)::float8 as "amountCents"
from (
  select 'hour' as kind, hour_bucket as key, paid_amount_cents from filtered
  union all
  select 'hour-source', hour_source, paid_amount_cents from filtered
  union all
  select 'punctuality', punctuality, paid_amount_cents from filtered
  union all
  select 'weekday', extract(isodow from payment_date)::int::text, paid_amount_cents from filtered where payment_date is not null
  union all
  select 'method', coalesce(nullif(btrim(payment_description), ''), 'Não informado'), paid_amount_cents from filtered
  union all
  select 'month', to_char(payment_date, 'YYYY-MM'), paid_amount_cents from filtered where payment_date is not null
) buckets
group by kind, key
order by kind, key`;

const PAGE_SQL = ANALYTICS_BASE_SQL + `
select id, member_id as "memberId", member_name as "memberName", cpf, external_user_code as "associatedCode",
       external_installment_code as "installment", installment_type as "installmentType",
       campaigns, batches, due_date::text as "dueDate", payment_date::text as "paymentDate",
       payment_description as "paymentMethod", payment_status as "paymentStatus",
       processing_status as "processingStatus",
       amount_cents::float8 as "amountCents", paid_amount_cents::float8 as "paidAmountCents",
       pending_amount_cents::float8 as "pendingAmountCents",
       delay_days as "delayDays", punctuality, hour_bucket as "hourBucket",
       estimated_hour as "estimatedHour", hour_source as "hourSource"
from filtered order by payment_date desc nulls last, id asc
limit $22::int offset $23::int`;

export type AnalyticsGroup = { kind: string; key: string; count: number; amountCents: number };
export type AnalyticsMetric = {
  installmentCount: number; memberCount: number; paidAmountCents: number;
  averageTicketCents: number | null; onTimeCount: number; lateCount: number;
  punctualityUnavailable: number; averageLateDays: number | null;
  hourUnavailable: number; hourBetween: number;
};
export type AnalyticsRow = {
  id: string; memberId: string; memberName: string | null; cpf: string | null;
  associatedCode: string | null; installment: string; installmentType: string | null;
  campaigns: string | null; batches: string | null; dueDate: string | null;
  paymentDate: string | null; paymentMethod: string | null; paymentStatus: string;
  processingStatus: string; amountCents: number; paidAmountCents: number | null;
  pendingAmountCents: number; delayDays: number | null; punctuality: string;
  hourBucket: string; estimatedHour: string | null;
  hourSource: "observed-window" | "erp-detection" | "unavailable";
};
export const ANALYTICS_PAGE_SIZE = 50;

export function analyticsSqlArgs(f: AnalyticsFilters) {
  const money = (value: string) => value ? Math.round(Number(value.replace(",", ".")) * 100) : null;
  return [
    f.campaign ?? [], f.batch ?? [], f.query ?? "", f.code ?? "", f.installment ?? "",
    f.dueDateFrom || null, f.dueDateTo || null, f.paymentDateFrom || null,
    f.paymentDateTo || null, f.status ?? [], f.payment ?? [], f.paidPending ?? "all",
    f.receipt ?? [], f.installmentType ?? [], f.from || null, f.to || null,
    f.hour, f.punctuality, money(f.amountMin), money(f.amountMax), f.weekday
  ];
}

export async function getAnalyticsReport(filters: AnalyticsFilters, trace?: AnalyticsPerfTrace | null) {
  const args = analyticsSqlArgs(filters);
  // Financial metrics remain live and identical on every tab.
  // The invoice table is rendered only on "faturas"; charts are rendered
  // only on the other tabs. Avoid the unused third query in each case.
  // All SQL, canonical installment deduplication and search semantics stay unchanged.
  const measure = <T>(stage: string, operation: () => Promise<T>) =>
    trace ? trace.measure(stage, operation) : operation();
  const [metrics, groups, page] = await Promise.all([
    measure("metrics", () => dbQuery<AnalyticsMetric>(METRICS_SQL, args)),
    filters.tab === "faturas"
      ? Promise.resolve(null)
      : measure("groups", () => dbQuery<AnalyticsGroup>(GROUP_SQL, args)),
    filters.tab === "faturas"
      ? measure("page", () => dbQuery<AnalyticsRow>(
          PAGE_SQL, [...args, ANALYTICS_PAGE_SIZE, (filters.page - 1) * ANALYTICS_PAGE_SIZE]
        ))
      : Promise.resolve(null)
  ]);
  return {
    metrics: metrics.rows[0]!,
    groups: groups?.rows ?? [],
    rows: page?.rows ?? [],
    page: filters.page,
    pageSize: ANALYTICS_PAGE_SIZE
  };
}

export async function getAnalyticsExportRows(filters: AnalyticsFilters) {
  const args = analyticsSqlArgs(filters);
  const limit = 100001;
  const result = await dbQuery<AnalyticsRow>(PAGE_SQL, [...args, limit, 0]);
  if (result.rows.length > 100000) throw new Error("Limite de exportação excedido (100.000 parcelas).");
  return result.rows;
}
