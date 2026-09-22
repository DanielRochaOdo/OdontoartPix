import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PageSurface } from "@/components/page-surface";
import {
  getPaymentDetails, getPaymentMethods, getPaymentReport,
  paymentFilterSearch, readPaymentFilters, sortPaymentGroups,
  type GroupKind, type PaymentFilters, type ReportGroup, type ReportMetric, type ReportTab
} from "@/lib/payment-punctuality";

export const dynamic = "force-dynamic";

const TABS: Array<{ key: ReportTab; label: string; description: string }> = [
  { key: "geral", label: "Visão geral", description: "Panorama da pontualidade dos recebimentos." },
  { key: "planos", label: "Planos", description: "Comparativo entre Clínico e Orto." },
  { key: "vencimentos", label: "Vencimentos", description: "Dias do mês com maior atraso e média por vencimento." },
  { key: "formas", label: "Formas de pagamento", description: "Tempo até a quitação conforme a modalidade recebida." }
];

const LABEL_BY_METRIC: Record<ReportMetric, string> = {
  avg: "Atraso médio", rate: "Taxa de atraso",
  count: "Quantidade de parcelas", amount: "Valor financeiro"
};

const number = (value: number) => value.toLocaleString("pt-BR");
const decimal = (value: number) => value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const percent = (value: number) => value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
const humanDate = (iso: string | null) => iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "—";

function valueOf(group: ReportGroup, metric: ReportMetric) {
  return metric === "count" ? group.count
    : metric === "rate" ? group.lateRate
    : metric === "amount" ? group.amountCents : group.averageDays;
}

function metricText(group: ReportGroup, metric: ReportMetric) {
  return metric === "count" ? number(group.count)
    : metric === "rate" ? percent(group.lateRate)
    : metric === "amount" ? money(group.amountCents) : decimal(group.averageDays) + " dias";
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <article className="odonto-card min-w-0 p-4 sm:p-5">
      <p className="text-xs font-medium text-secondary">{label}</p>
      <p className="mt-2 break-words text-2xl font-bold tracking-tight text-primary sm:text-[28px]">{value}</p>
      <p className="mt-2 text-xs text-muted">{hint}</p>
    </article>
  );
}

function filterSelect(name: string, label: string, selected: string, options: Array<{ value: string; label: string }>) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-secondary">
      {label}
      <select name={name} defaultValue={selected} className="odonto-control w-full px-3 py-2 text-[13px]">
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function Filters({ filters, methods }: { filters: PaymentFilters; methods: string[] }) {
  return (
    <form action="/pontualidade" method="get" className="odonto-card mt-6 p-4 sm:p-5">
      <input type="hidden" name="tab" value={filters.tab} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-primary">Filtros da análise</h2>
          <p className="mt-1 text-xs text-secondary">Os filtros permanecem ativos ao navegar entre os relatórios.</p>
        </div>
        <Link href="/pontualidade" className="rounded-lg border border-default px-3 py-2 text-xs font-semibold text-secondary hover:bg-surface-hover">Limpar filtros</Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filterSelect("period", "Período de vencimento", filters.period, [
          { value: "12m", label: "Últimos 12 meses" }, { value: "30d", label: "Últimos 30 dias" },
          { value: "3m", label: "Últimos 3 meses" }, { value: "6m", label: "Últimos 6 meses" },
          { value: "all", label: "Todo o histórico" }, { value: "custom", label: "Personalizado" }
        ])}
        {filterSelect("plan", "Plano", filters.plan, [
          { value: "all", label: "Todos os planos" }, { value: "clinico", label: "Clínico" },
          { value: "orto", label: "Orto" }, { value: "sem-classificacao", label: "Não classificado" }
        ])}
        {filterSelect("due", "Dia do vencimento", filters.due ? String(filters.due) : "", [
          { value: "", label: "Todos os dias" }, ...Array.from({ length: 31 }, (_, i) => ({
            value: String(i + 1), label: "Dia " + String(i + 1).padStart(2, "0")
          }))
        ])}
        {filterSelect("method", "Forma de pagamento", filters.method, [
          { value: "", label: "Todas as formas" },
          ...methods.map((item) => ({ value: item, label: item }))
        ])}
        {filterSelect("scope", "Situação das parcelas", filters.scope, [
          { value: "paid", label: "Pagas" }, { value: "late", label: "Pagas com atraso" },
          { value: "open", label: "Em aberto e vencidas" }
        ])}
        {filterSelect("metric", "Ordenar por", filters.metric, [
          { value: "avg", label: "Média de dias de atraso" },
          { value: "rate", label: "Percentual em atraso" },
          { value: "count", label: "Quantidade de parcelas" },
          { value: "amount", label: "Valor financeiro" }
        ])}
        {filterSelect("order", "Ordem", filters.order, [
          { value: "desc", label: "Maior para menor" }, { value: "asc", label: "Menor para maior" }
        ])}
        <div className="flex items-end">
          <button type="submit" className="min-h-[39px] w-full rounded-lg bg-brand px-5 py-2 text-sm font-bold text-white transition hover:opacity-90">Aplicar filtros</button>
        </div>
      </div>
      <div className="mt-4 grid gap-3 border-t border-subtle pt-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-xs font-semibold text-secondary">
          Data inicial (período personalizado)
          <input type="date" name="from" defaultValue={filters.period === "custom" ? filters.from : ""}
            className="odonto-control w-full px-3 py-2 text-[13px]" />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-semibold text-secondary">
          Data final (período personalizado)
          <input type="date" name="to" defaultValue={filters.period === "custom" ? filters.to : ""}
            className="odonto-control w-full px-3 py-2 text-[13px]" />
        </label>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        O intervalo personalizado será utilizado ao selecionar “Personalizado”. Os demais períodos são móveis e calculados a partir da data local do sistema.
      </p>
    </form>
  );
}

function BarRanking({
  groups, filters, title, limit = 12
}: { groups: ReportGroup[]; filters: PaymentFilters; title: string; limit?: number }) {
  const max = Math.max(1, ...groups.map((item) => valueOf(item, filters.metric)));
  return (
    <section className="odonto-card min-w-0 p-4 sm:p-5">
      <h3 className="text-sm font-bold text-primary">{title}</h3>
      <p className="mt-1 text-xs text-muted">{LABEL_BY_METRIC[filters.metric]} · {filters.order === "desc" ? "maior para menor" : "menor para maior"}</p>
      <div className="mt-5 space-y-4">
        {groups.slice(0, limit).map((item) => (
          <Link key={item.kind + item.key} href={paymentFilterSearch(filters, { detailKind: item.kind, detailKey: item.key }) + "#detalhamento"}
            className="group block rounded-lg outline-offset-4 focus-visible:outline-2 focus-visible:outline-brand"
            title={"Ver parcelas de " + item.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate font-semibold text-primary group-hover:text-brand">{item.label}</span>
              <span className="shrink-0 tabular-nums font-bold text-secondary">{metricText(item, filters.metric)}</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-tertiary">
              <div className="h-full rounded-full bg-[#23adab]" style={{ width: (valueOf(item, filters.metric) / max * 100) + "%" }} />
            </div>
          </Link>
        ))}
        {!groups.length && <p className="text-sm text-muted">Nenhuma parcela encontrada para esses filtros.</p>}
      </div>
      {groups.length > limit ? <p className="mt-4 text-xs text-muted">Exibindo {limit} de {groups.length} categorias. Consulte a tabela para a lista completa.</p> : null}
    </section>
  );
}

function RankingTable({ groups, filters, kind }: { groups: ReportGroup[]; filters: PaymentFilters; kind: GroupKind }) {
  const title = kind === "plan" ? "Planos" : kind === "due" ? "Dia de vencimento" : "Forma de pagamento";
  const flip = paymentFilterSearch(filters, { order: filters.order === "desc" ? "asc" : "desc", detailKind: "", detailKey: "" });
  return (
    <section className="odonto-card min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle p-4 sm:px-5">
        <div>
          <h3 className="text-sm font-bold text-primary">Detalhamento por {title.toLocaleLowerCase("pt-BR")}</h3>
          <p className="mt-1 text-xs text-secondary">Clique em uma linha para consultar até 50 parcelas do grupo.</p>
        </div>
        <Link href={flip} className="rounded-lg border border-default px-3 py-2 text-xs font-semibold text-secondary hover:bg-surface-hover">
          {filters.order === "desc" ? "↓ Maior para menor" : "↑ Menor para maior"} · inverter
        </Link>
      </div>
      <div className="w-full overflow-x-auto">
        <table className="w-full min-w-[650px] border-collapse text-left text-[13px]">
          <thead className="bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-secondary">
            <tr>
              <th scope="col" className="px-4 py-3">{title}</th>
              <th scope="col" className="px-4 py-3 text-right">Média de atraso</th>
              <th scope="col" className="px-4 py-3 text-right">Média dos atrasados</th>
              <th scope="col" className="px-4 py-3 text-right">Taxa de atraso</th>
              <th scope="col" className="px-4 py-3 text-right">Parcelas</th>
              <th scope="col" className="px-4 py-3 text-right">Valor</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((item) => (
              <tr key={item.kind + item.key} className="border-t border-subtle hover:bg-surface-hover">
                <th scope="row" className="p-0 font-semibold text-brand">
                  <Link href={paymentFilterSearch(filters, { detailKind: item.kind, detailKey: item.key }) + "#detalhamento"}
                    className="block px-4 py-3 underline-offset-4 hover:underline">{item.label} ↗</Link>
                </th>
                <td className="px-4 py-3 text-right tabular-nums">{decimal(item.averageDays)} dias</td>
                <td className="px-4 py-3 text-right tabular-nums">{decimal(item.lateAverageDays)} dias</td>
                <td className="px-4 py-3 text-right tabular-nums">{percent(item.lateRate)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{number(item.count)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(item.amountCents)}</td>
              </tr>
            ))}
            {!groups.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">Nenhum resultado para os filtros selecionados.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function PunctualityPage({
  searchParams
}: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const params = (await searchParams) ?? {};
  let filters: PaymentFilters;
  try {
    filters = readPaymentFilters(params);
  } catch (error) {
    return (
      <PageSurface>
        <PageHeader eyebrow="Relatórios financeiros" title="Pontualidade de Pagamentos" />
        <div role="alert" className="odonto-card mt-6 border-danger bg-danger-soft p-5 text-sm text-danger">
          {error instanceof Error ? error.message : "Filtro inválido."} <Link href="/pontualidade" className="font-bold underline">Limpar filtros</Link>
        </div>
      </PageSurface>
    );
  }

  let report: Awaited<ReturnType<typeof getPaymentReport>>;
  let methods: string[];
  try {
    [report, methods] = await Promise.all([getPaymentReport(filters), getPaymentMethods()]);
  } catch (error) {
    console.error("[PUNCTUALITY_REPORT_FAILED]", { message: error instanceof Error ? error.message : "Erro desconhecido" });
    return (
      <PageSurface>
        <PageHeader eyebrow="Relatórios financeiros" title="Pontualidade de Pagamentos" />
        <div role="alert" className="odonto-card mt-6 border-danger bg-danger-soft p-5 text-sm text-danger">
          Não foi possível consultar os pagamentos agora. Atualize a página ou tente novamente mais tarde.
        </div>
      </PageSurface>
    );
  }

  const all = report.groups;
  const plans = sortPaymentGroups(all.filter((item) => item.kind === "plan"), filters);
  const dues = sortPaymentGroups(all.filter((item) => item.kind === "due"), filters);
  const paymentMethods = sortPaymentGroups(all.filter((item) => item.kind === "method"), filters);
  const current = TABS.find((item) => item.key === filters.tab)!;
  const detailKindParam = typeof params.detailKind === "string" ? params.detailKind : "";
  const detailKey = typeof params.detailKey === "string" ? params.detailKey : "";
  const detailKind = ["plan", "due", "method", "total"].includes(detailKindParam) && detailKey
    ? detailKindParam as GroupKind : null;
  const selectedGroup = detailKind ? all.find((g) => g.kind === detailKind && g.key === detailKey) : null;
  let details: Awaited<ReturnType<typeof getPaymentDetails>> = [];
  if (selectedGroup) {
    try {
      details = await getPaymentDetails(filters, selectedGroup.kind, selectedGroup.key);
    } catch (error) {
      console.error("[PUNCTUALITY_DETAILS_FAILED]", { message: error instanceof Error ? error.message : "Erro desconhecido" });
    }
  }

  const scopeTitle = filters.scope === "open" ? "Dias em aberto" : "Atraso médio";
  const scopeHint = filters.scope === "open" ? "Dias desde o vencimento até hoje, somente parcelas vencidas"
    : "Dias corridos entre o vencimento e a quitação; pontuais contam zero";
  const periodLabel = (filters.from ? humanDate(filters.from) : "Início do histórico") + " até " + (filters.to ? humanDate(filters.to) : "hoje");

  return (
    <PageSurface>
      <PageHeader eyebrow="Relatórios financeiros" title="Pontualidade de Pagamentos"
        description="Análise das parcelas reais por plano, dia de vencimento e forma de pagamento." />
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-secondary">
        <span className="rounded-full border border-subtle bg-surface-primary px-3 py-1.5">{periodLabel}</span>
        <span className="rounded-full border border-subtle bg-surface-primary px-3 py-1.5">
          {filters.scope === "open" ? "Em aberto e vencidas" : filters.scope === "late" ? "Pagas com atraso" : "Pagas"}
        </span>
        <span className="rounded-full border border-subtle bg-surface-primary px-3 py-1.5">Dados reais · atualizados ao abrir</span>
      </div>
      <Filters filters={filters} methods={methods} />

      <nav aria-label="Relatórios de pontualidade" className="mt-6 flex gap-1 overflow-x-auto border-b border-subtle">
        {TABS.map((tab) => (
          <Link key={tab.key} href={paymentFilterSearch(filters, { tab: tab.key, detailKind: "", detailKey: "" })}
            aria-current={filters.tab === tab.key ? "page" : undefined}
            className={`shrink-0 border-b-[3px] px-4 py-3 text-[13px] font-bold transition-colors ${filters.tab === tab.key
              ? "border-brand text-brand" : "border-transparent text-secondary hover:border-default hover:text-primary"}`}>
            {tab.label}
          </Link>
        ))}
      </nav>

      <section className="mt-6" aria-label={current.label}>
        <h2 className="text-lg font-bold text-primary">{current.label}</h2>
        <p className="mt-1 text-sm text-secondary">{current.description}</p>
        {filters.scope === "open" ? (
          <p className="mt-3 rounded-lg border border-warning bg-warning-soft p-3 text-xs text-warning">
            Em aberto: o indicador representa dias já vencidos, não dias até a quitação. A forma de pagamento efetiva ainda não existe; a aba de modalidades não permite comparação neste filtro.
          </p>
        ) : null}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={scopeTitle} value={decimal(report.total.averageDays) + " dias"} hint={scopeHint} />
          <StatCard label={filters.scope === "open" ? "Parcelas em atraso" : "Parcelas quitadas"}
            value={number(report.total.count)} hint="Obrigações financeiras únicas analisadas" />
          <StatCard label={filters.scope === "open" ? "Taxa de vencidas" : "Pagas após o vencimento"}
            value={percent(report.total.lateRate)} hint={number(report.total.lateCount) + " de " + number(report.total.count) + " parcelas"} />
          <StatCard label={filters.scope === "open" ? "Valor em aberto" : "Valor recebido"}
            value={money(report.total.amountCents)} hint="Somatório financeiro das parcelas elegíveis" />
        </div>

        {filters.tab === "geral" ? (
          <div className="mt-5 grid gap-4 xl:grid-cols-3">
            <BarRanking title="Planos" groups={plans} filters={filters} limit={3} />
            <BarRanking title="Vencimentos" groups={dues} filters={filters} limit={8} />
            <BarRanking title="Formas de pagamento" groups={filters.scope === "open" ? [] : paymentMethods} filters={filters} limit={8} />
          </div>
        ) : filters.tab === "planos" ? (
          <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(260px,0.9fr)_minmax(0,1.7fr)]">
            <BarRanking title="Comparação de planos" groups={plans} filters={filters} limit={3} />
            <RankingTable kind="plan" groups={plans} filters={filters} />
          </div>
        ) : filters.tab === "vencimentos" ? (
          <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(260px,0.9fr)_minmax(0,1.7fr)]">
            <BarRanking title="Dias do mês" groups={dues} filters={filters} limit={31} />
            <RankingTable kind="due" groups={dues} filters={filters} />
          </div>
        ) : (
          <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(260px,0.9fr)_minmax(0,1.7fr)]">
            <BarRanking title="Modalidades de recebimento" groups={filters.scope === "open" ? [] : paymentMethods} filters={filters} limit={30} />
            <RankingTable kind="method" groups={filters.scope === "open" ? [] : paymentMethods} filters={filters} />
          </div>
        )}

        {selectedGroup ? (
          <section id="detalhamento" className="odonto-card mt-5 overflow-hidden" aria-label="Detalhamento de parcelas">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-subtle p-4 sm:p-5">
              <div>
                <h3 className="text-base font-bold text-primary">Parcelas · {selectedGroup.label}</h3>
                <p className="mt-1 text-xs text-secondary">Até 50 parcelas, ordenadas por dias de atraso. Total do grupo: {number(selectedGroup.count)}.</p>
              </div>
              <Link href={paymentFilterSearch(filters)} className="rounded-lg border border-default px-3 py-2 text-xs font-semibold text-secondary hover:bg-surface-hover">Fechar detalhes</Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[750px] border-collapse text-left text-xs">
                <thead className="bg-surface-secondary text-secondary">
                  <tr>
                    {["Associado", "Parcela", "Plano", "Vencimento", "Quitação", "Pagamento", "Dias", "Valor"].map((label) =>
                      <th scope="col" key={label} className="px-4 py-3">{label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {details.map((item) => (
                    <tr key={item.id} className="border-t border-subtle hover:bg-surface-hover">
                      <td className="px-4 py-3 font-semibold text-primary">{item.memberName}</td>
                      <td className="px-4 py-3">{item.code}</td>
                      <td className="px-4 py-3">{item.plan}</td>
                      <td className="px-4 py-3 tabular-nums">{humanDate(item.dueDate)}</td>
                      <td className="px-4 py-3 tabular-nums">{humanDate(item.paymentDate)}</td>
                      <td className="px-4 py-3">{filters.scope === "open" ? "Não aplicável" : item.method}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-bold">{number(item.days)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(item.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
        <p className="mt-5 text-xs leading-relaxed text-muted">
          Base: parcelas canônicas vinculadas a campanhas e lotes ativos, sem duplicar a mesma obrigação em vários lotes. O período se refere ao vencimento. Pagamentos sem data válida de quitação ou vencimento não entram na média; parcelas acordadas e excluídas não são consideradas pagas. A taxa de atraso usa somente as parcelas elegíveis no filtro atual. A modalidade informa a forma efetivamente utilizada, não a causa do atraso.
        </p>
      </section>
    </PageSurface>
  );
}
