import { dbQuery } from "@/lib/db/pool";

export type ReportTab = "geral" | "planos" | "vencimentos" | "formas";
export type ReportScope = "paid" | "late" | "open";
export type ReportMetric = "avg" | "rate" | "count" | "amount";
export type ReportOrder = "desc" | "asc";
export type GroupKind = "total" | "plan" | "due" | "method";

export type PaymentFilters = {
  period: "12m" | "30d" | "3m" | "6m" | "all" | "custom";
  from: string;
  to: string;
  plan: "all" | "clinico" | "orto" | "sem-classificacao";
  due: number | null;
  method: string;
  scope: ReportScope;
  metric: ReportMetric;
  order: ReportOrder;
  tab: ReportTab;
  asOf: string;
};

export type ReportGroup = {
  kind: GroupKind;
  key: string;
  label: string;
  count: number;
  lateCount: number;
  averageDays: number;
  lateAverageDays: number;
  amountCents: number;
  lateRate: number;
};

export type PaymentDetail = {
  id: string;
  memberId: string;
  memberName: string;
  code: string;
  plan: string;
  dueDate: string;
  paymentDate: string | null;
  method: string;
  days: number;
  amountCents: number;
};

const PIX_DESCRIPTIONS = [
  "PIX", "PIX - CLINICO", "PIX - ORTODONTIA",
  "PIX NEW ODONTO - P4X", "PIX NEW ODONTOLOGIA - P4X",
  "PIX ODONTOART - P4X", "PIX RECORRENTE ODONTOART - P4X"
] as const;

// Mesma lista explicitamente adotada pelo card Pix e pelo Resumo e Análise.
// Não converter indiscriminadamente qualquer descrição contendo a palavra PIX.
export function normalizePaymentMethod(description: string | null | undefined) {
  const value = description?.trim() ?? "";
  if (!value) return "Não informado";
  return (PIX_DESCRIPTIONS as readonly string[]).includes(value.toLocaleUpperCase("pt-BR"))
    ? "Pix" : value;
}

function validIsoDate(value: string) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function reportToday(now: Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
}

function daysBefore(date: string, days: number) {
  const parsed = new Date(date + "T00:00:00Z");
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

function monthsBefore(date: string, months: number) {
  const [year, month, day] = date.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 - months, 1));
  const maxDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, maxDay));
  return first.toISOString().slice(0, 10);
}

function readEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

export function readPaymentFilters(
  params: Record<string, string | string[] | undefined>,
  today = reportToday()
): PaymentFilters {
  const value = (name: string) => typeof params[name] === "string" ? params[name] as string : undefined;
  const period = readEnum(value("period"), ["12m", "30d", "3m", "6m", "all", "custom"] as const, "12m");
  const customFrom = value("from") ?? "";
  const customTo = value("to") ?? "";
  if (period === "custom" && (
    (customFrom && !validIsoDate(customFrom)) || (customTo && !validIsoDate(customTo)) ||
    (customFrom && customTo && customFrom > customTo)
  )) throw new Error("Período personalizado inválido.");

  const from = period === "custom" ? customFrom
    : period === "all" ? "" : period === "30d" ? daysBefore(today, 29)
    : monthsBefore(today, period === "3m" ? 3 : period === "6m" ? 6 : 12);
  const to = period === "custom" ? customTo : today;
  const dueText = value("due") ?? "";
  if (dueText && (!/^[0-9]{1,2}$/.test(dueText) || Number(dueText) < 1 || Number(dueText) > 31)) {
    throw new Error("Dia de vencimento inválido.");
  }
  const method = (value("method") ?? "").trim();
  if (method.length > 120) throw new Error("Forma de pagamento inválida.");
  return {
    period, from, to,
    plan: readEnum(value("plan"), ["all", "clinico", "orto", "sem-classificacao"] as const, "all"),
    due: dueText ? Number(dueText) : null,
    method,
    scope: readEnum(value("scope"), ["paid", "late", "open"] as const, "paid"),
    metric: readEnum(value("metric"), ["avg", "rate", "count", "amount"] as const, "avg"),
    order: readEnum(value("order"), ["desc", "asc"] as const, "desc"),
    tab: readEnum(value("tab"), ["geral", "planos", "vencimentos", "formas"] as const, "geral"),
    asOf: today
  };
}

export function paymentFilterSearch(filters: PaymentFilters, updates: Record<string, string> = {}) {
  const params = new URLSearchParams({
    period: filters.period, plan: filters.plan, due: filters.due ? String(filters.due) : "",
    method: filters.method, scope: filters.scope, metric: filters.metric,
    order: filters.order, tab: filters.tab
  });
  if (filters.period === "custom") {
    params.set("from", filters.from);
    params.set("to", filters.to);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  return "/pontualidade?" + params.toString();
}

// Este parser só recebe o formato que a API financeira já armazena no banco.
// O roundtrip abaixo rejeita datas impossíveis (por exemplo, 31/02).
export function parseFinancialDate(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  const iso = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:$|[T ])/.exec(text);
  const br = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/.exec(text);
  let normalized = iso ? iso[1] + "-" + iso[2] + "-" + iso[3]
    : br ? br[3] + "-" + br[2].padStart(2, "0") + "-" + br[1].padStart(2, "0") : "";
  if (!normalized && /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2})$/.test(text)) {
    const match = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2})$/.exec(text)!;
    const year = Number(match[3]) >= 70 ? "19" : "20";
    normalized = year + match[3] + "-" + match[1].padStart(2, "0") + "-" + match[2].padStart(2, "0");
  }
  return normalized && validIsoDate(normalized) ? normalized : null;
}

export function delayDays(due: string, payment: string) {
  return Math.max(0, Math.round((
    Date.parse(payment + "T00:00:00Z") - Date.parse(due + "T00:00:00Z")
  ) / 86400000));
}

export function aggregatePaymentRows(rows: Array<{
  due_date_text: string | null;
  payment_date_text: string | null;
  payment_status: string | null;
  installment_type: string | null;
  payment_description: string | null;
  paid_amount_cents: number | null;
  pending_amount_cents: number;
}>, filters: PaymentFilters) {
  // Função pura para validar o significado dos indicadores sem depender do ERP.
  const selected = rows.flatMap((row) => {
    const due = parseFinancialDate(row.due_date_text);
    const paid = parseFinancialDate(row.payment_date_text);
    if (!due || (filters.from && due < filters.from) || (filters.to && due > filters.to) || due > filters.asOf) return [];
    if (filters.plan !== "all" && (row.installment_type ?? "sem-classificacao") !== filters.plan) return [];
    if (filters.due && Number(due.slice(8, 10)) !== filters.due) return [];
    const method = normalizePaymentMethod(row.payment_description);
    if (filters.method && method !== filters.method) return [];
    if (filters.scope === "open" ? row.payment_status !== "unpaid"
      : row.payment_status !== "paid" || !paid || paid > filters.asOf || row.paid_amount_cents === null) return [];
    const days = filters.scope === "open" ? delayDays(due, filters.asOf) : delayDays(due, paid!);
    if (filters.scope === "late" && days === 0) return [];
    return [{ days, amount: filters.scope === "open" ? row.pending_amount_cents : row.paid_amount_cents ?? 0 }];
  });
  return {
    count: selected.length,
    averageDays: selected.length ? selected.reduce((sum, row) => sum + row.days, 0) / selected.length : 0,
    lateCount: selected.filter((row) => row.days > 0).length
  };
}

const dateSql = (column: string) => `case
  when btrim(coalesce(${column}, '')) ~ '^([1-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])($|[T ])'
    then to_date(left(btrim(${column}), 10), 'YYYY-MM-DD')
  when btrim(coalesce(${column}, '')) ~ '^(0?[1-9]|[12][0-9]|3[01])/(0?[1-9]|1[0-2])/[1-9][0-9]{3}$'
    then to_date(btrim(${column}), 'DD/MM/YYYY')
  when btrim(coalesce(${column}, '')) ~ '^(0?[1-9]|1[0-2])/(0?[1-9]|[12][0-9]|3[01])/[0-9]{2}$'
    then to_date(btrim(${column}), 'MM/DD/YY')
  else null::date end`;

const pixSql = PIX_DESCRIPTIONS.map((item) => "'" + item.replaceAll("'", "''") + "'").join(", ");

export const PAYMENT_SOURCE_SQL = `with candidate as (
  select canonical.id, canonical.member_id, m.name as member_name,
         canonical.external_installment_code, canonical.installment_type,
         canonical.due_date_text, canonical.payment_date_text,
         canonical.payment_status, canonical.payment_description,
         canonical.paid_amount_cents, canonical.pending_amount_cents,
         ${dateSql("canonical.due_date_text")} as due_raw,
         ${dateSql("canonical.payment_date_text")} as payment_raw
  from member_target_installments canonical
  join members m on m.id = canonical.member_id and m.deleted_at is null
  where exists (
    select 1 from campaign_batch_members cbm
    join campaigns c on c.id = cbm.campaign_id and c.deleted_at is null
    join campaign_batches b on b.id = cbm.batch_id and b.deleted_at is null
    where cbm.target_installment_ref_id = canonical.id and cbm.deleted_at is null
  )
), parsed as (
  select *,
    case
      when due_date_text ~ '^[0-9]{4}-' and to_char(due_raw, 'YYYY-MM-DD') = left(btrim(due_date_text), 10) then due_raw
      when due_date_text ~ '/' and length(split_part(due_date_text, '/', 3)) = 4
       and to_char(due_raw, 'DD/MM/YYYY') = lpad(split_part(btrim(due_date_text), '/', 1), 2, '0') || '/' ||
         lpad(split_part(btrim(due_date_text), '/', 2), 2, '0') || '/' || split_part(btrim(due_date_text), '/', 3) then due_raw
      when due_date_text ~ '/' and length(split_part(due_date_text, '/', 3)) = 2 then due_raw
      else null::date end as due_date,
    case
      when payment_date_text ~ '^[0-9]{4}-' and to_char(payment_raw, 'YYYY-MM-DD') = left(btrim(payment_date_text), 10) then payment_raw
      when payment_date_text ~ '/' and length(split_part(payment_date_text, '/', 3)) = 4
       and to_char(payment_raw, 'DD/MM/YYYY') = lpad(split_part(btrim(payment_date_text), '/', 1), 2, '0') || '/' ||
         lpad(split_part(btrim(payment_date_text), '/', 2), 2, '0') || '/' || split_part(btrim(payment_date_text), '/', 3) then payment_raw
      when payment_date_text ~ '/' and length(split_part(payment_date_text, '/', 3)) = 2 then payment_raw
      else null::date end as payment_date
  from candidate
), normalized as (
  select *,
    coalesce(nullif(btrim(installment_type), ''), 'sem-classificacao') as plan,
    case when upper(btrim(coalesce(payment_description, ''))) in (${pixSql}) then 'Pix'
      else coalesce(nullif(btrim(payment_description), ''), 'Não informado') end as method,
    extract(day from due_date)::int as due_day
  from parsed
), selected as (
  select *, case when $7::text = 'open'
      then greatest($8::date - due_date, 0)
      else greatest(payment_date - due_date, 0) end as days,
    case when $7::text = 'open' then pending_amount_cents else paid_amount_cents end as report_amount_cents
  from normalized
  where due_date is not null and due_date <= $8::date
    and ($1::date is null or due_date >= $1::date)
    and ($2::date is null or due_date <= $2::date)
    and ($3::text = 'all' or plan = $3::text)
    and ($4::int is null or due_day = $4::int)
    and ($5::text = '' or method = $5::text)
    and (($7::text = 'open' and payment_status = 'unpaid' and due_date < $8::date)
      or ($7::text <> 'open' and payment_status = 'paid'
        and paid_amount_cents is not null and payment_date is not null
        and payment_date <= $8::date))
), eligible as (
  select * from selected where $7::text <> 'late' or days > 0
)`;

const groupQuery = PAYMENT_SOURCE_SQL + `
select
  case when grouping(plan) = 0 then 'plan'
    when grouping(due_day) = 0 then 'due'
    when grouping(method) = 0 then 'method'
    else 'total' end as kind,
  case when grouping(plan) = 0 then plan
    when grouping(due_day) = 0 then due_day::text
    when grouping(method) = 0 then method
    else 'all' end as key,
  count(*)::int as count,
  count(*) filter (where days > 0)::int as late_count,
  coalesce(round(avg(days)::numeric, 2), 0)::float8 as average_days,
  coalesce(round(avg(days) filter (where days > 0)::numeric, 2), 0)::float8 as late_average_days,
  coalesce(sum(report_amount_cents), 0)::float8 as amount_cents
from eligible
group by grouping sets ((), (plan), (due_day), (method))
`;

// SQL usa intervalo fechado [from, to] na data original de vencimento.
// $6 fica reservado para expansão de filtros sem mudar assinatura de consulta.
function queryValues(filters: PaymentFilters): unknown[] {
  return [filters.from || null, filters.to || null, filters.plan, filters.due,
    filters.method, null, filters.scope, filters.asOf];
}

type GroupRow = {
  kind: GroupKind; key: string; count: number; late_count: number;
  average_days: number; late_average_days: number; amount_cents: number;
};

function labelForGroup(kind: GroupKind, key: string) {
  if (kind === "plan") return key === "clinico" ? "Clínico"
    : key === "orto" ? "Orto" : "Não classificado";
  if (kind === "due") return "Dia " + key.padStart(2, "0");
  return kind === "total" ? "Todos os pagamentos" : key;
}

export async function getPaymentReport(filters: PaymentFilters) {
  const result = await dbQuery<GroupRow>(groupQuery, queryValues(filters));
  const groups: ReportGroup[] = result.rows.map((row) => {
    const count = Number(row.count);
    const lateCount = Number(row.late_count);
    return {
      kind: row.kind, key: row.key, label: labelForGroup(row.kind, row.key),
      count, lateCount, averageDays: Number(row.average_days),
      lateAverageDays: Number(row.late_average_days), amountCents: Number(row.amount_cents),
      lateRate: count ? lateCount / count * 100 : 0
    };
  });
  const total = groups.find((item) => item.kind === "total") ?? {
    kind: "total" as const, key: "all", label: "Todos os pagamentos", count: 0,
    lateCount: 0, averageDays: 0, lateAverageDays: 0, amountCents: 0, lateRate: 0
  };
  return { groups, total };
}

export function sortPaymentGroups(groups: ReportGroup[], filters: PaymentFilters) {
  const value = (group: ReportGroup) => filters.metric === "rate" ? group.lateRate
    : filters.metric === "count" ? group.count
    : filters.metric === "amount" ? group.amountCents : group.averageDays;
  return [...groups].sort((a, b) => {
    const diff = value(a) - value(b);
    return (filters.order === "desc" ? -diff : diff) || a.label.localeCompare(b.label, "pt-BR", { numeric: true });
  });
}

export async function getPaymentMethods() {
  const result = await dbQuery<{ description: string | null }>(`
    select distinct payment_description as description
    from member_target_installments
    where payment_status = 'paid' and payment_description is not null
    order by payment_description
  `);
  return [...new Set(result.rows.map((row) => normalizePaymentMethod(row.description)))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

export async function getPaymentDetails(filters: PaymentFilters, kind: GroupKind, key: string) {
  if (kind === "due" && (!/^[0-9]{1,2}$/.test(key) || Number(key) < 1 || Number(key) > 31)) {
    throw new Error("Detalhamento inválido.");
  }
  if (kind === "plan" && !["clinico", "orto", "sem-classificacao"].includes(key)) {
    throw new Error("Detalhamento inválido.");
  }
  if (kind === "method" && key.length > 120) throw new Error("Detalhamento inválido.");
  const result = await dbQuery<{
    id: string; member_id: string; member_name: string | null;
    external_installment_code: string; plan: string;
    due_date: string; payment_date: string | null; method: string;
    days: number; report_amount_cents: number;
  }>(PAYMENT_SOURCE_SQL + `
    select id, member_id, member_name, external_installment_code, plan,
      to_char(due_date, 'YYYY-MM-DD') as due_date,
      case when payment_date is null then null else to_char(payment_date, 'YYYY-MM-DD') end as payment_date,
      method, days, report_amount_cents::float8 as report_amount_cents
    from eligible
    where ($9::text = 'total'
      or ($9::text = 'plan' and plan = $10::text)
      or ($9::text = 'due' and due_day = $10::int)
      or ($9::text = 'method' and method = $10::text))
    order by days desc, due_date desc, id
    limit 50
  `, [...queryValues(filters), kind, key]);
  return result.rows.map((row): PaymentDetail => ({
    id: row.id, memberId: row.member_id, memberName: row.member_name ?? "Associado sem nome",
    code: row.external_installment_code, plan: labelForGroup("plan", row.plan),
    dueDate: row.due_date, paymentDate: row.payment_date, method: row.method,
    days: Number(row.days), amountCents: Number(row.report_amount_cents)
  }));
}
