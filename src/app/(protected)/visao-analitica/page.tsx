import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PageSurface } from "@/components/page-surface";
import { AnalyticsPaymentFilters } from "@/components/analytics-payment-filters";
import { AnalyticsInvoiceTable } from "@/components/analytics-invoice-table";
import { getAssociadosCardFilterOptions } from "@/lib/associados-paginated";
import {
  ANALYTIC_HOURS, analyticsSearch, getAnalyticsReport, readAnalyticsFilters,
  type AnalyticsFilters, type AnalyticsGroup
} from "@/lib/analytics-payments";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "panorama", label: "Panorama financeiro" },
  { key: "horarios", label: "Horários de pagamento" },
  { key: "comportamento", label: "Comportamento" },
  { key: "comparativos", label: "Comparativos" },
  { key: "faturas", label: "Consulta de faturas" }
] as const;

const money = (cents: number | null) => cents == null ? "—"
  : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const number = (value: number) => value.toLocaleString("pt-BR");
const percentage = (value: number, total: number) =>
  total ? (value * 100 / total).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%" : "—";
const labelHour = (hour: string) => hour === "between" ? "Entre faixas" : hour === "unavailable" ? "Indisponível"
  : hour.replace("-", "h–") + "h";
const labelPunctuality: Record<string, string> = {
  early: "Antecipados", "on-time": "No vencimento", late: "Atrasados", unavailable: "Indisponível"
};
const WEEKDAYS = ["", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];

function Stat({ title, value, caption }: { title: string; value: string; caption?: string }) {
  return <div className="odonto-card min-w-0 p-4 sm:p-5">
    <p className="text-xs font-semibold text-secondary">{title}</p>
    <p className="mt-2 break-words text-xl font-bold tracking-tight text-primary sm:text-2xl">{value}</p>
    {caption && <p className="mt-1 text-xs text-muted">{caption}</p>}
  </div>;
}

function HoursChart({ groups, filters }: { groups: AnalyticsGroup[]; filters: AnalyticsFilters }) {
  const entries = ANALYTIC_HOURS.map((key) => ({
    key, count: groups.find((item) => item.kind === "hour" && item.key === key)?.count ?? 0
  }));
  const max = Math.max(1, ...entries.map((entry) => entry.count));
  const extra = ["between", "unavailable"].map((key) => ({
    key, count: groups.find((item) => item.kind === "hour" && item.key === key)?.count ?? 0
  }));
  return <section className="odonto-card min-w-0 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-bold text-primary">Pagamentos por faixa de horário</h2>
        <p className="mt-1 text-xs text-secondary">Parcelas pagas por período de duas horas</p>
      </div>
      <Link href={"/visao-analitica?" + analyticsSearch(filters, { hour: "all", page: 1, tab: "faturas" })}
        className="text-xs font-semibold text-brand hover:underline">Ver todas as faturas</Link>
    </div>
    <div className="mt-6 grid grid-cols-6 gap-2 sm:grid-cols-12 sm:gap-3">
      {entries.map((entry) => <Link key={entry.key}
        href={"/visao-analitica?" + analyticsSearch(filters, { hour: entry.key, page: 1, tab: "faturas" })}
        className="group flex min-w-0 flex-col items-center gap-2 rounded-lg p-1 hover:bg-surface-hover"
        title={labelHour(entry.key) + ": " + number(entry.count) + " pagamentos"}>
        <span className="text-[10px] font-bold tabular-nums text-secondary sm:text-xs">{number(entry.count)}</span>
        <div className="flex h-40 w-full items-end overflow-hidden rounded-md bg-surface-secondary">
          <div className="w-full rounded-t-md bg-[#23adab] transition group-hover:bg-[#138c87]"
            style={{ height: (entry.count ? Math.max(5, entry.count / max * 100) : 0) + "%" }} />
        </div>
        <span className="text-[10px] font-medium tabular-nums text-secondary sm:text-xs">
          {entry.key.replace("-", "–")}
        </span>
      </Link>)}
    </div>
    <div className="mt-5 flex flex-wrap gap-3 border-t border-subtle pt-4">
      {extra.map((item) => <Link key={item.key}
        href={"/visao-analitica?" + analyticsSearch(filters, { hour: item.key, page: 1, tab: "faturas" })}
        className="rounded-lg border border-default px-3 py-2 text-xs text-secondary hover:bg-surface-hover">
        {labelHour(item.key)}: <strong className="text-primary">{number(item.count)}</strong>
      </Link>)}
    </div>
  </section>;
}

function GroupChart({ title, description, groups, kind, filters, label, change, limit = 12 }: {
  title: string; description?: string; groups: AnalyticsGroup[]; kind: string;
  filters: AnalyticsFilters; label: (key: string) => string;
  change?: (key: string) => Record<string, string | number | null>; limit?: number;
}) {
  const entries = groups.filter((entry) => entry.kind === kind)
    .sort((a, b) => b.count - a.count).slice(0, limit);
  const max = Math.max(1, ...entries.map((entry) => entry.count));
  return <section className="odonto-card min-w-0 p-4 sm:p-5">
    <h2 className="text-base font-bold text-primary">{title}</h2>
    {description && <p className="mt-1 text-xs text-secondary">{description}</p>}
    <div className="mt-5 space-y-3">
      {entries.map((entry) => {
        const update = change?.(entry.key);
        const content = <>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate font-medium text-primary">{label(entry.key)}</span>
            <span className="shrink-0 font-bold tabular-nums text-secondary">{number(entry.count)} · {money(entry.amountCents)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-tertiary">
            <div className="h-full rounded-full bg-[#23adab]" style={{ width: (entry.count / max * 100) + "%" }} />
          </div>
        </>;
        return update
          ? <Link key={entry.key} href={"/visao-analitica?" + analyticsSearch(filters, { ...update, page: 1, tab: "faturas" })}
              className="block rounded-lg p-1 hover:bg-surface-hover">{content}</Link>
          : <div key={entry.key} className="rounded-lg p-1">{content}</div>;
      })}
      {!entries.length && <p className="text-sm text-secondary">Nenhum pagamento encontrado.</p>}
    </div>
  </section>;
}

function nextMonth(key: string) {
  const [year, month] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month, 1));
  return date.toISOString().slice(0, 10);
}

export default async function AnalyticsPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  let filters: AnalyticsFilters;
  try {
    filters = readAnalyticsFilters((await searchParams) ?? {});
  } catch {
    return <PageSurface><PageHeader title="Visão Analítica" description="Pagamentos e recebimentos" />
      <div className="odonto-card mt-5 p-5">
        <p className="text-sm text-secondary">Os filtros informados são inválidos.</p>
        <Link className="mt-3 inline-block text-sm font-semibold text-brand" href="/visao-analitica">Limpar filtros</Link>
      </div>
    </PageSurface>;
  }
  let report: Awaited<ReturnType<typeof getAnalyticsReport>>;
  let options: Awaited<ReturnType<typeof getAssociadosCardFilterOptions>>;
  try {
    [report, options] = await Promise.all([
      getAnalyticsReport(filters), getAssociadosCardFilterOptions()
    ]);
  } catch (error) {
    console.error("[PAYMENT_ANALYTICS_LOAD_FAILED]", error);
    return <PageSurface><PageHeader title="Visão Analítica" description="Pagamentos e recebimentos" />
      <p className="odonto-card mt-5 p-5 text-sm text-secondary">Não foi possível carregar a análise. Tente novamente.</p>
    </PageSurface>;
  }
  const { metrics, groups, rows } = report;
  const paginationStart = (filters.page - 1) * report.pageSize;
  const pages = Math.max(1, Math.ceil(metrics.installmentCount / report.pageSize));

  return <PageSurface className="lg:px-5 xl:px-6">
    <PageHeader eyebrow="Recebimentos" title="Visão Analítica"
      description="Entenda os horários, a pontualidade e o comportamento dos pagamentos." />
    <AnalyticsPaymentFilters filters={filters} options={options} />
    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <Stat title="Valor recebido" value={money(metrics.paidAmountCents)} />
      <Stat title="Parcelas pagas" value={number(metrics.installmentCount)} />
      <Stat title="Associados pagantes" value={number(metrics.memberCount)} />
      <Stat title="Ticket médio" value={money(metrics.averageTicketCents)} />
      <Stat title="Pagamentos no prazo" value={percentage(metrics.onTimeCount, metrics.installmentCount - metrics.punctualityUnavailable)} />
      <Stat title="Atraso médio" value={metrics.averageLateDays == null ? "—" : metrics.averageLateDays.toLocaleString("pt-BR") + " dias"} />
    </div>

    <nav className="mt-6 flex flex-wrap gap-2" aria-label="Seções da Visão Analítica">
      {TABS.map((tab) => <Link key={tab.key}
        href={"/visao-analitica?" + analyticsSearch(filters, { tab: tab.key, page: 1 })}
        aria-current={filters.tab === tab.key ? "page" : undefined}
        className={"rounded-lg border px-3 py-2 text-xs font-semibold transition sm:text-sm " +
          (filters.tab === tab.key ? "border-brand bg-surface-secondary text-brand" : "border-default text-secondary hover:bg-surface-hover")}>
        {tab.label}
      </Link>)}
    </nav>

    {["panorama", "horarios"].includes(filters.tab) && <div className="mt-5">
      <HoursChart groups={groups} filters={filters} />
    </div>}
    {filters.tab === "panorama" && <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <GroupChart title="Pontualidade dos pagamentos" groups={groups} kind="punctuality"
        filters={filters} label={(key) => labelPunctuality[key] ?? key}
        change={(key) => ({ punctuality: key })} />
      <GroupChart title="Recebimentos por dia da semana" groups={groups} kind="weekday"
        filters={filters} label={(key) => WEEKDAYS[Number(key)] ?? key} limit={7} />
    </div>}
    {filters.tab === "horarios" && <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <GroupChart title="Recebimentos por dia da semana" groups={groups} kind="weekday"
        filters={filters} label={(key) => WEEKDAYS[Number(key)] ?? key} limit={7} />
      <GroupChart title="Horários e pontualidade" description="Distribuição da pontualidade neste período"
        groups={groups} kind="punctuality" filters={filters}
        label={(key) => labelPunctuality[key] ?? key} change={(key) => ({ punctuality: key })} />
    </div>}
    {filters.tab === "comportamento" && <div className="mt-5 grid gap-4 lg:grid-cols-2">
      <GroupChart title="Pontualidade dos pagamentos" groups={groups} kind="punctuality"
        filters={filters} label={(key) => labelPunctuality[key] ?? key}
        change={(key) => ({ punctuality: key })} />
      <GroupChart title="Formas de recebimento" groups={groups} kind="method"
        filters={filters} label={(key) => key} limit={12} />
    </div>}
    {filters.tab === "comparativos" && <div className="mt-5 grid gap-4 lg:grid-cols-2">
      <GroupChart title="Recebimentos por mês" groups={groups} kind="month" filters={filters}
        label={(key) => key.slice(5, 7) + "/" + key.slice(0, 4)}
        change={(key) => ({ from: key + "-01", to: new Date(Date.parse(nextMonth(key)) - 86400000).toISOString().slice(0, 10) })} />
      <GroupChart title="Recebimentos por dia da semana" groups={groups} kind="weekday"
        filters={filters} label={(key) => WEEKDAYS[Number(key)] ?? key} limit={7} />
      <GroupChart title="Formas de pagamento" groups={groups} kind="method"
        filters={filters} label={(key) => key} limit={12} />
      <GroupChart title="Pontualidade" groups={groups} kind="punctuality"
        filters={filters} label={(key) => labelPunctuality[key] ?? key}
        change={(key) => ({ punctuality: key })} />
    </div>}
    {filters.tab === "faturas" && <section className="odonto-card mt-5 min-w-0 p-4 sm:p-5" id="faturas">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-primary">Consulta de faturas pagas</h2>
          <p className="mt-1 text-xs text-secondary">
            {number(metrics.installmentCount)} faturas · {number(metrics.memberCount)} associados
          </p>
        </div>
        <a href={"/api/visao-analitica/exportar?" + analyticsSearch(filters, { page: null })}
          className="rounded-lg border border-default px-3 py-2 text-xs font-semibold text-brand hover:bg-surface-hover">
          Exportar Excel
        </a>
      </div>
      <AnalyticsInvoiceTable rows={rows} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-secondary">
        <span>{metrics.installmentCount ? number(paginationStart + 1) + "–" + number(Math.min(paginationStart + report.pageSize, metrics.installmentCount)) : "0"} de {number(metrics.installmentCount)}</span>
        <div className="flex items-center gap-3">
          <Link href={"/visao-analitica?" + analyticsSearch(filters, { page: Math.max(1, filters.page - 1) })}
            aria-disabled={filters.page <= 1}
            className={filters.page <= 1 ? "pointer-events-none opacity-40" : "font-semibold text-brand"}>Anterior</Link>
          <span>Página {number(filters.page)} de {number(pages)}</span>
          <Link href={"/visao-analitica?" + analyticsSearch(filters, { page: Math.min(pages, filters.page + 1) })}
            aria-disabled={filters.page >= pages}
            className={filters.page >= pages ? "pointer-events-none opacity-40" : "font-semibold text-brand"}>Próxima</Link>
        </div>
      </div>
    </section>}
  </PageSurface>;
}
