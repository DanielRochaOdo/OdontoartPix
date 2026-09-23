import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PageSurface } from "@/components/page-surface";
import { PunctualityFilters } from "@/components/punctuality-filters";
import {
  getPaymentDateReconciliation, getPaymentDetails, getPaymentMethods, getPaymentReport,
  getPaymentMethodChanges, getPaymentMethodChangeDetails,
  paymentFilterSearch, readPaymentFilters, sortPaymentGroups,
  type GroupKind, type PaymentFilters, type ReportGroup, type ReportMetric, type ReportTab
} from "@/lib/payment-punctuality";

export const dynamic = "force-dynamic";

const TABS: Array<{ key: ReportTab; label: string; description: string }> = [
  { key: "geral", label: "Visão geral", description: "Panorama da pontualidade dos recebimentos." },
  { key: "planos", label: "Planos", description: "Comparativo entre Clínico e Orto." },
  { key: "vencimentos", label: "Vencimentos", description: "Dias do mês com maior atraso e média por vencimento." },
  { key: "formas", label: "Formas de pagamento", description: "Tempo até a quitação conforme a modalidade recebida." },
  { key: "trocas", label: "Troca de pagamento", description: "Comparação da forma configurada no ERP com a forma realmente utilizada em cada parcela paga." }
];

const LABEL_BY_METRIC: Record<ReportMetric, string> = {
  avg: "Atraso médio", rate: "Taxa de atraso",
  count: "Quantidade de parcelas", amount: "Valor financeiro"
};

const number = (value: number) => value.toLocaleString("pt-BR");
const decimal = (value: number) => value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const percent = (value: number) => value.toLocaleString("pt-BR", {
  minimumFractionDigits: value > 0 && value < 0.1 || value > 99.9 && value < 100 ? 2 : 1,
  maximumFractionDigits: 2
}) + "%";
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
  let reconciliation: Awaited<ReturnType<typeof getPaymentDateReconciliation>>;
  try {
    [report, methods, reconciliation] = await Promise.all([
      getPaymentReport(filters), getPaymentMethods(), getPaymentDateReconciliation(filters)
    ]);
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
  const showAllChanges = params.show === "all";
  const changeReport = filters.tab === "trocas" ? await getPaymentMethodChanges(filters) : null;
  const sortedChangeRows = changeReport ? [...changeReport.rows].filter((row) => showAllChanges || row.changed).sort((left, right) => {
    const value = (row: typeof left) => filters.metric === "count" ? row.count
      : filters.metric === "amount" ? row.amountCents
      : filters.metric === "rate" ? row.lateRate : row.averageDays;
    return (filters.order === "desc" ? -1 : 1) * (value(left) - value(right)) ||
      left.configured.localeCompare(right.configured, "pt-BR") || left.received.localeCompare(right.received, "pt-BR");
  }) : [];
  const changeFrom = typeof params.changeFrom === "string" ? params.changeFrom : "";
  const changeTo = typeof params.changeTo === "string" ? params.changeTo : "";
  const selectedChange = changeReport?.rows.find((row) => row.configured === changeFrom && row.received === changeTo);
  const changeDetails = selectedChange ? await getPaymentMethodChangeDetails(filters, changeFrom, changeTo) : [];
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

  const openOnly = filters.scopes.length === 1 && filters.scopes[0] === "open";
  const includesOpen = filters.scopes.includes("open");
  const includesPaid = filters.scopes.includes("paid") || filters.scopes.includes("late");
  const scopeTitle = openOnly ? "Dias em aberto" : includesOpen ? "Tempo médio em dias" : "Atraso médio";
  const scopeHint = openOnly ? "Dias decorridos desde o vencimento até hoje"
    : includesOpen ? "Pagas: dias até quitar; em aberto: dias decorridos desde o vencimento"
    : "Dias corridos entre o vencimento e a quitação; pontuais contam zero";
  const periodLabel = filters.period === "all" || (!filters.from && !filters.to)
    ? "Todo o histórico"
    : (filters.from ? humanDate(filters.from) : "Início do histórico") + " até " + (filters.to ? humanDate(filters.to) : "hoje");
  const scopeLabel = filters.scopes.length === 3 ? "Pagas no prazo + com atraso + em aberto"
    : filters.scopes.includes("paid") && filters.scopes.includes("late") ? "Pagas no prazo + pagas com atraso" + (includesOpen ? " + em aberto" : "")
    : filters.scopes.map((scope) => scope === "paid" ? "Pagas no prazo" : scope === "late" ? "Pagas com atraso" : "Em aberto e vencidas").join(" + ");

  return (
    <PageSurface>
      <PageHeader eyebrow="Relatórios financeiros" title="Pontualidade de Pagamentos"
        description="Análise das parcelas reais por plano, dia de vencimento e forma de pagamento." />
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-secondary">
        <span className="rounded-full border border-subtle bg-surface-primary px-3 py-1.5">
          {periodLabel}{filters.period !== "all" ? " · " + (filters.dateBasis === "payment" ? "Data do pagamento" : "Data do vencimento") : ""}
        </span>
        <span className="rounded-full border border-subtle bg-surface-primary px-3 py-1.5">
          {scopeLabel}
        </span>
        <span className="rounded-full border border-subtle bg-surface-primary px-3 py-1.5">Dados reais · atualizados ao abrir</span>
      </div>
      <PunctualityFilters key={paymentFilterSearch(filters)} filters={filters} methods={methods} />

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
        {includesOpen ? (
          <p className="mt-3 rounded-lg border border-warning bg-warning-soft p-3 text-xs text-warning">
            Parcelas em aberto são medidas em dias decorridos desde o vencimento, não em dias até a quitação. Ao combiná-las com pagamentos quitados, os indicadores misturam durações de naturezas diferentes. A comparação por forma de pagamento é exibida somente quando são selecionadas situações de parcelas pagas.
          </p>
        ) : null}
        <div className={`mt-5 grid gap-3 sm:grid-cols-2 ${openOnly ? "xl:grid-cols-4" : "xl:grid-cols-5"}`}>
          <StatCard label={scopeTitle} value={decimal(report.total.averageDays) + " dias"} hint={scopeHint} />
          <StatCard label={openOnly ? "Parcelas em atraso" : includesOpen ? "Parcelas analisadas" : "Parcelas quitadas"}
            value={number(report.total.count)} hint={includesOpen ? number(report.total.paidCount) + " quitadas · " + number(report.total.openCount) + " em aberto" : "Obrigações financeiras únicas analisadas"} />
          {!openOnly ? (
            <>
              <StatCard label="Pagas no prazo" value={number(report.total.onTimeCount)}
                hint={percent(report.total.paidCount ? report.total.onTimeCount / report.total.paidCount * 100 : 0) + " · " + number(report.total.onTimeCount) + " de " + number(report.total.paidCount) + " pagas"} />
              <StatCard label="Pagas com atraso" value={number(report.total.paidCount - report.total.onTimeCount)}
                hint={percent(report.total.paidCount ? (report.total.paidCount - report.total.onTimeCount) / report.total.paidCount * 100 : 0) + " · " + number(report.total.paidCount - report.total.onTimeCount) + " de " + number(report.total.paidCount) + " pagas"} />
            </>
          ) : (
            <StatCard label="Parcelas vencidas" value={number(report.total.openCount)}
              hint="Sem data de quitação; dias decorridos desde o vencimento" />
          )}
          <StatCard label={openOnly ? "Valor em aberto" : includesOpen ? "Valor financeiro analisado" : "Valor recebido"}
            value={money(report.total.amountCents)} hint="Somatório financeiro das parcelas elegíveis" />
        </div>

        {reconciliation ? (
          <div className="mt-4 rounded-xl border border-info bg-info-soft p-4 text-xs leading-relaxed text-info" role="status">
            <strong>Conferência por data de pagamento:</strong> {number(reconciliation.matchedRows)} parcelas com pagamento datado
            no intervalo selecionado, das quais {number(reconciliation.paidRows)} têm situação “paga”.
            {reconciliation.missingDueRows || reconciliation.missingAmountRows ? (
              <span> Entre as pagas, {number(reconciliation.missingDueRows)} não têm vencimento válido
                e {number(reconciliation.missingAmountRows)} não têm valor pago informado; essas ocorrências
                não podem ser classificadas com segurança como pontuais ou atrasadas.
              </span>
            ) : null}
            <span> O relatório contabiliza somente parcelas pagas classificáveis nas situações escolhidas.
              O módulo Associados também pode exibir outros status nessa mesma data.
            </span>
          </div>
        ) : null}

        {filters.tab === "trocas" && changeReport ? (
          <section className="mt-5 space-y-4" aria-label="Mudança entre forma configurada e utilizada">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Parcelas comparáveis" value={number(changeReport.compared)}
                hint={number(changeReport.totalPaid) + " parcelas pagas no filtro atual"} />
              <StatCard label="Forma de pagamento alterada" value={number(changeReport.changed)}
                hint={percent(changeReport.compared ? changeReport.changed / changeReport.compared * 100 : 0) + " das parcelas com as duas formas conhecidas"} />
              <StatCard label="Mesma forma configurada" value={number(changeReport.unchanged)}
                hint="Método previsto e método recebido equivalentes" />
              <StatCard label="Sem informação para comparar" value={number(changeReport.withoutConfigured)}
                hint="Descrições configurada/recebida ausentes; não classificadas como mudança" />
            </div>
            <div className="rounded-xl border border-info bg-info-soft px-4 py-3 text-xs leading-relaxed text-info">
              Comparamos <strong>DescricaoPagamento</strong> (forma configurada no ERP para a parcela)
              com <strong>DescricaoRecebimento</strong> (forma efetivamente utilizada).
              Descrições Pix equivalentes e variações de boleto bancário não contam como troca.
              Dados de configurações anteriores à implantação podem não estar armazenados: são apresentados
              como não informados até uma nova consulta ao ERP, sem inferência a partir da forma recebida.
              A comparação considera exclusivamente parcelas pagas com datas elegíveis nos filtros.
            </div>
            <div className="odonto-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle p-4 sm:px-5">
                <div>
                  <h3 className="text-sm font-bold text-primary">Origem → forma utilizada</h3>
                  <p className="mt-1 text-xs text-secondary">Clique em uma linha para conferir os associados e as parcelas. O percentual do card usa apenas as parcelas comparáveis.</p>
                </div>
                <Link className="rounded-lg border border-default px-3 py-2 text-xs font-semibold text-secondary hover:bg-surface-hover"
                  href={paymentFilterSearch(filters, { show: showAllChanges ? "" : "all", changeFrom: "", changeTo: "" })}>
                  {showAllChanges ? "Mostrar somente alterações" : "Mostrar alterações e formas mantidas"}
                </Link>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] border-collapse text-left text-xs">
                  <thead className="bg-surface-secondary text-secondary">
                    <tr>
                      {["Forma configurada", "Forma utilizada", "Comparação", "Parcelas", "Atraso médio", "Valor recebido"].map((name) => (
                        <th key={name} scope="col" className="px-4 py-3">{name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedChangeRows.map((row) => (
                      <tr key={JSON.stringify([row.configured, row.received])} className="border-t border-subtle hover:bg-surface-hover">
                        <td className="p-0 font-semibold text-primary">
                          <Link className="block px-4 py-3 underline-offset-4 hover:text-brand hover:underline"
                            href={paymentFilterSearch(filters, {
                              show: showAllChanges ? "all" : "",
                              changeFrom: row.configured, changeTo: row.received
                            }) + "#troca-detalhamento"}>{row.configured} ↗</Link>
                        </td>
                        <td className="px-4 py-3">{row.received}</td>
                        <td className="px-4 py-3">
                          <span className={row.changed ? "font-semibold text-warning" : "text-success"}>
                            {row.changed ? "Alterada" : "Mantida"}
                          </span>
                        </td>
                        <td className="px-4 py-3 tabular-nums">{number(row.count)}</td>
                        <td className="px-4 py-3 tabular-nums">{decimal(row.averageDays)} dias</td>
                        <td className="px-4 py-3 tabular-nums">{money(row.amountCents)}</td>
                      </tr>
                    ))}
                    {!sortedChangeRows.length ? (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">
                        {changeReport.compared === 0 ? "Nenhuma parcela possui as duas formas de pagamento registradas neste filtro."
                          : "Não foram encontradas trocas de forma de pagamento neste filtro."}
                      </td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
            {selectedChange ? (
              <section id="troca-detalhamento" className="odonto-card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle p-4">
                  <div>
                    <h3 className="text-sm font-bold text-primary">
                      Parcelas · {selectedChange.configured} → {selectedChange.received}
                    </h3>
                    <p className="mt-1 text-xs text-secondary">Exibindo até 50 parcelas, sem duplicar uma obrigação por lote/campanha.</p>
                  </div>
                  <Link className="rounded-lg border border-default px-3 py-2 text-xs text-secondary hover:bg-surface-hover"
                    href={paymentFilterSearch(filters, { show: showAllChanges ? "all" : "" })}>Fechar detalhes</Link>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[800px] border-collapse text-left text-xs">
                    <thead className="bg-surface-secondary text-secondary">
                      <tr>{["Associado", "Parcela", "Plano", "Vencimento", "Pagamento", "Forma configurada", "Forma recebida", "Dias de atraso"].map((label) =>
                        <th scope="col" key={label} className="px-4 py-3">{label}</th>)}</tr>
                    </thead>
                    <tbody>{changeDetails.map((item) => (
                      <tr key={item.id} className="border-t border-subtle hover:bg-surface-hover">
                        <td className="px-4 py-3 font-semibold text-primary">{item.memberName}</td>
                        <td className="px-4 py-3">{item.code}</td>
                        <td className="px-4 py-3">{item.plan}</td>
                        <td className="px-4 py-3 tabular-nums">{humanDate(item.dueDate)}</td>
                        <td className="px-4 py-3 tabular-nums">{humanDate(item.paymentDate)}</td>
                        <td className="px-4 py-3">{item.configuredMethod ?? "Não informado"}</td>
                        <td className="px-4 py-3">{item.method}</td>
                        <td className="px-4 py-3 tabular-nums">{number(item.days)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </section>
        ) : null}

        {filters.tab === "geral" ? (
          <div className="mt-5 grid gap-4 xl:grid-cols-3">
            <BarRanking title="Planos" groups={plans} filters={filters} limit={3} />
            <BarRanking title="Vencimentos" groups={dues} filters={filters} limit={8} />
            <BarRanking title="Formas de pagamento" groups={includesOpen ? [] : paymentMethods} filters={filters} limit={8} />
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
            <BarRanking title="Modalidades de recebimento" groups={includesOpen ? [] : paymentMethods} filters={filters} limit={30} />
            <RankingTable kind="method" groups={includesOpen ? [] : paymentMethods} filters={filters} />
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
                      <td className="px-4 py-3">{item.paymentDate ? item.method : "Não aplicável"}</td>
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
          Base: parcelas canônicas vinculadas a campanhas e lotes ativos, sem duplicar a mesma obrigação em vários lotes. Sem período selecionado, considera todo o histórico de pagamentos registrado até a data da consulta. O período pode ser aplicado à data de pagamento (mesma referência temporal do filtro de Associados) ou ao vencimento. A quantidade de associados exibidos em Associados não equivale necessariamente à quantidade de parcelas pagas com datas válidas. Pagamentos sem data válida de quitação ou vencimento não entram na média; parcelas acordadas e excluídas não são consideradas pagas. A taxa de atraso usa somente as parcelas elegíveis no filtro atual. A modalidade informa a forma efetivamente utilizada, não a causa do atraso.
        </p>
      </section>
    </PageSurface>
  );
}
