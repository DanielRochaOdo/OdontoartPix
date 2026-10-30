"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { useEffect, useMemo, useState } from "react";
import { calculateAverageTicketCents, formatCurrencyBR } from "@/lib/money";
import { ManualDashboardIcon } from "@/components/manual-dashboard-icon";
import type { DashboardReceiptStatus } from "@/lib/metrics";
import {
  findReceiptPaymentMapping,
  isOpenReceiptPayment,
  RECEIPT_SUMMARY_ORDER,
  type ReceiptPaymentSummaryName
} from "@/lib/receipt-payment-summary";

type ChartValue = {
  label: string;
  value: number;
  color: string;
};

const chartCardClassName =
  "flex h-full min-h-[244px] flex-col rounded-2xl border border-subtle bg-surface-primary p-4 shadow-[0_5px_22px_rgba(31,49,85,0.045)] transition hover:border-brand/70    ";
const lowerChartCardClassName =
  "flex h-full min-h-[216px] flex-col rounded-2xl border border-subtle bg-surface-primary p-4 shadow-[0_5px_22px_rgba(31,49,85,0.045)]   ";

function ChartTitleIcon({ type }: { type: "chart" | "value" | "ticket" | "insight" }) {
  const name = type === "value" ? "values" : type === "ticket" ? "ticket" : type === "insight" ? "insights" : "miniChart";
  return <ManualDashboardIcon name={name} className="h-5 w-5" />;
}

function DonutChart({
  title,
  centerValue,
  values,
  formatter,
  compactCenterValue = false
}: {
  title: string;
  centerValue: string;
  values: ChartValue[];
  formatter?: (value: number) => string;
  compactCenterValue?: boolean;
}) {
  const total = values.reduce((sum, item) => sum + item.value, 0);
  const normalizedCenterValue = centerValue.replace(/\s+/g, " ").trim();
  const centerLines = compactCenterValue
    ? (() => {
        if (normalizedCenterValue.startsWith("R$ ")) {
          return ["R$", normalizedCenterValue.slice(3)];
        }
        if (normalizedCenterValue.startsWith("R$")) {
          return ["R$", normalizedCenterValue.slice(2).trim()];
        }
        return [normalizedCenterValue];
      })()
    : [normalizedCenterValue];
  const centerValueClassName =
    compactCenterValue && centerLines.join("").length > 14
      ? "text-sm font-semibold fill-[#102033] dark:fill-[#edf6ff]"
      : compactCenterValue
        ? "text-lg font-semibold fill-[#102033] dark:fill-[#edf6ff]"
        : "text-xl font-semibold fill-[#102033] dark:fill-[#edf6ff]";
  const centerStartY = centerLines.length > 1 ? 44 : 50;

  return (
    <article className={chartCardClassName}>
      <h3 className="flex items-center gap-2 text-base font-semibold text-primary ">
        <ChartTitleIcon type={title === "Valores" ? "value" : "chart"} />
        {title}
      </h3>
      <div className="mt-3 h-[176px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={values}
              dataKey="value"
              nameKey="label"
              innerRadius={54}
              outerRadius={84}
              paddingAngle={2}
              strokeWidth={0}
            >
              {values.map((item) => (
                <Cell key={item.label} fill={item.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, _name, item) => {
                const label = item.payload.label as string;
                const numericValue = Number(value ?? 0);
                return [formatter ? formatter(numericValue) : String(numericValue), label];
              }}
              contentStyle={{
                backgroundColor: "var(--chart-tooltip-bg, #071b34)",
                border: "1px solid rgba(62, 112, 147, 0.65)",
                borderRadius: "12px",
                color: "var(--chart-tooltip-fg, #edf6ff)"
              }}
            />
            <text x="50%" y={`${centerStartY}%`} textAnchor="middle" fill="currentColor" className={centerValueClassName}>
              {centerLines.map((line, index) => (
                <tspan
                  key={`${title}-${line}-${index}`}
                  x="50%"
                  dy={index === 0 ? 0 : 25}
                  dominantBaseline={index === 0 ? "middle" : undefined}
                >
                  {line}
                </tspan>
              ))}
            </text>
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-4 space-y-2">
        {values.map((item) => {
          const percentage = total > 0 ? (item.value / total) * 100 : 0;
          return (
            <div key={item.label} className="flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="text-secondary ">{item.label}</span>
              </div>
              <div className="text-right font-medium text-primary ">
                {formatter ? formatter(item.value) : item.value.toLocaleString("pt-BR")} {" | "}
                <span className="text-muted ">
                  {percentage.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

const RECEIPT_STATUS_COLORS = ["#00B8FF", "#22D58C", "#FFB547", "#A78BFA", "#FF5B5B", "#14B8A6"];

const RECEIPT_SUMMARY_COLORS: Record<ReceiptPaymentSummaryName, string> = {
  ACORDADO: "#FFB547",
  EXCLUIDA: "#A78BFA",
  "BOLETO CLÍNICO": "#F472B6",
  "BOLETO ORTO": "#38BDF8",
  "CARTÃO ORTO": "#22D58C",
  "CARTÃO CLÍNICO": "#FACC15",
  DINHEIRO: "#FF5B5B",
  ENEL: "#A78BFA",
  "PIX CLÍNICO": "#22D3EE",
  "PIX RECORRENTE": "#A3E635",
  "PIX ORTO": "#38BDF8"
};

function ReceiptStatusChart({ statuses }: { statuses: DashboardReceiptStatus[] }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [receiptSearch, setReceiptSearch] = useState("");
  const values = useMemo(
    () =>
      statuses
        .filter((status) => !isOpenReceiptPayment(status.label))
        .map((status, index) => ({
          label: status.label,
          value: status.installmentCount,
          associateCount: status.associateCount,
          amountCents: status.amountCents,
          color: RECEIPT_STATUS_COLORS[index % RECEIPT_STATUS_COLORS.length]
        })),
    [statuses]
  );

  const groupedStatuses = useMemo(() => {
    const groups = new Map<string, {
      summary: string;
      color: string;
      items: Array<(typeof values)[number] & { systemLabel: string }>;
    }>();

    for (const summary of RECEIPT_SUMMARY_ORDER) {
      groups.set(summary, {
        summary,
        color: RECEIPT_SUMMARY_COLORS[summary],
        items: []
      });
    }

    const unmapped: Array<(typeof values)[number] & { systemLabel: string }> = [];
    for (const item of values) {
      const mapping = findReceiptPaymentMapping(item.label);
      if (!mapping) {
        unmapped.push({ ...item, systemLabel: item.label });
        continue;
      }
      groups.get(mapping.summary)?.items.push({
        ...item,
        systemLabel: mapping.systemLabel
      });
    }

    const ordered: Array<{
      summary: string;
      color: string;
      items: Array<(typeof values)[number] & { systemLabel: string }>;
    }> = RECEIPT_SUMMARY_ORDER.map((summary) => {
      const group = groups.get(summary)!;
      return {
        ...group,
        items: group.items.slice().sort((left, right) =>
          right.amountCents - left.amountCents || left.systemLabel.localeCompare(right.systemLabel, "pt-BR")
        )
      };
    });

    if (unmapped.length > 0) {
      ordered.push({
        summary: "NÃO MAPEADO",
        color: "#64748B",
        items: unmapped.slice().sort((left, right) =>
          right.amountCents - left.amountCents || left.systemLabel.localeCompare(right.systemLabel, "pt-BR")
        )
      });
    }
    return ordered;
  }, [values]);

  const totalInstallments = values.reduce((sum, item) => sum + item.value, 0);
  const totalPaidAmountCents = values.reduce((sum, item) => sum + item.amountCents, 0);
  const totalPaidAmountLabel = formatCurrencyBR(totalPaidAmountCents);
  const centerAmountClassName = totalPaidAmountLabel.length > 17
    ? "text-sm font-bold fill-[#102033] dark:fill-[#edf6ff]"
    : totalPaidAmountLabel.length > 13
      ? "text-base font-bold fill-[#102033] dark:fill-[#edf6ff]"
      : "text-lg font-bold fill-[#102033] dark:fill-[#edf6ff]";

  function openModal() {
    setModalOpen(true);
  }

  return (
    <>
      <article
        className={`${lowerChartCardClassName} cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-label="Abrir status de recebimento"
        onClick={openModal}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openModal();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-base font-semibold text-primary"><ChartTitleIcon type="insight" />Recebimentos</h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-secondary">
              <span>Parcelas agrupadas por DescricaoRecebimento.</span>
              <span className="font-semibold text-[#087eaf] dark:text-[#6edbff]">Clique em qualquer área para detalhar</span>
            </div>
          </div>
        </div>

        {values.length === 0 ? (
          <div className="mt-3 flex flex-1 items-center justify-center rounded-2xl border border-dashed border-subtle bg-surface-secondary px-5 text-center text-sm text-muted">
            Nenhum status de recebimento registrado ainda.
          </div>
        ) : (
          <div className="mt-3 h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={values}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={68}
                  outerRadius={104}
                  paddingAngle={2}
                  strokeWidth={0}
                >
                  {values.map((item) => <Cell key={item.label} fill={item.color} />)}
                </Pie>
                <Tooltip
                  formatter={(value, _name, item) => [
                    `${Number(value ?? 0).toLocaleString("pt-BR")} parcela(s) · ${Number(item.payload.associateCount ?? 0).toLocaleString("pt-BR")} associado(s)`,
                    item.payload.label
                  ]}
                  contentStyle={{
                    backgroundColor: "var(--chart-tooltip-bg, #071b34)",
                    border: "1px solid rgba(62, 112, 147, 0.65)",
                    borderRadius: "12px",
                    color: "var(--chart-tooltip-fg, #edf6ff)"
                  }}
                />
                <text x="50%" y="44%" textAnchor="middle" fill="currentColor" className={centerAmountClassName}>
                  {totalPaidAmountLabel}
                </text>
                <text x="50%" y="61%" textAnchor="middle" fill="currentColor" className="text-[9px] font-medium fill-[#6d8396] dark:fill-[#8fa7bc]">
                  {totalInstallments.toLocaleString("pt-BR")} parcelas
                </text>
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </article>

      {modalOpen ? (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-[#030711]/85 p-2 backdrop-blur-sm sm:p-5" role="presentation" onMouseDown={() => setModalOpen(false)}>
          <section role="dialog" aria-modal="true" aria-labelledby="receipt-status-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
            className="flex max-h-[calc(100dvh-1rem)] w-full max-w-[1440px] flex-col overflow-hidden rounded-[20px] border border-[#25334e] bg-[#0c1222] text-[#e7edf8] shadow-2xl sm:max-h-[calc(100dvh-2rem)]">
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-[#1c2940] px-5 py-5 sm:px-7">
              <div className="flex min-w-0 items-center gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-emerald-500/25 bg-emerald-500/10 text-emerald-400" aria-hidden="true">✓</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h4 id="receipt-status-modal-title" className="text-xl font-bold tracking-tight sm:text-2xl">Status de Recebimento</h4>
                    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-0.5 text-xs font-semibold text-emerald-400">Liquidado</span>
                  </div>
                  <p className="mt-1 text-xs text-[#91a1bb] sm:text-sm">Parcelas agrupadas por tipo de pagamento resumido e canais associados</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden rounded-lg border border-[#2b3b58] bg-[#15213a] px-3 py-2 text-xs text-[#c2cee0] sm:inline-flex">▣ &nbsp; Visão Consolidada Mensal</span>
                <button type="button" aria-label="Imprimir resumo de recebimento" title="Imprimir resumo" onClick={() => window.print()}
                  className="rounded-lg border border-[#31415d] bg-[#17233c] px-3 py-2 text-sm text-[#c2cee0] hover:bg-[#233454]">⎙</button>
                <button type="button" aria-label="Fechar status de recebimento" onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-[#31415d] bg-[#17233c] px-3 py-2 text-xl leading-none text-[#9eafca] hover:bg-[#233454]">×</button>
              </div>
            </header>
            <div className="grid shrink-0 gap-4 border-b border-[#1c2940] bg-gradient-to-r from-[#10192d] to-[#0c1222] px-5 py-6 sm:px-7 lg:grid-cols-[1.15fr_0.85fr_1.45fr]">
              <div className="rounded-2xl border border-[#2b3b58] bg-gradient-to-br from-[#19263d] to-[#10273a] p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#96a7c2]">Valor total recebido</p>
                  <span className="rounded bg-emerald-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400">100% dos canais</span>
                </div>
                <p className="mt-4 break-all font-mono text-2xl font-semibold tracking-tight sm:text-3xl">{totalPaidAmountLabel}</p>
                <p className="mt-2 text-xs text-[#91a1bb]">Soma líquida apurada de todos os métodos ativos</p>
              </div>
              <div className="rounded-2xl border border-[#2b3b58] bg-[#172139] p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#96a7c2]">Total de parcelas</p>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">Volumetria</span>
                </div>
                <p className="mt-4 font-mono text-3xl font-semibold">{totalInstallments.toLocaleString("pt-BR")}</p>
                <p className="mt-2 text-xs text-[#91a1bb]">Ticket Médio Geral: <strong className="font-mono text-[#dbe7f7]">{formatCurrencyBR(totalInstallments ? Math.round(totalPaidAmountCents / totalInstallments) : 0)}</strong></p>
              </div>
              <div className="flex flex-col justify-center rounded-2xl border border-[#2b3b58] bg-[#121b31] p-5">
                <div className="flex justify-between gap-2 text-xs text-[#c5d1e2]"><span>Composição da Receita por Método</span><span className="text-[#8293ad]">4 Grupos Principais</span></div>
                {(() => {
                  const buckets = [
                    { name: "PIX", color: "#22c8e3", amount: groupedStatuses.filter((g) => g.summary.startsWith("PIX")).flatMap((g) => g.items).reduce((n, x) => n + x.amountCents, 0) },
                    { name: "Cartão", color: "#818cf8", amount: groupedStatuses.filter((g) => g.summary.startsWith("CARTÃO")).flatMap((g) => g.items).reduce((n, x) => n + x.amountCents, 0) },
                    { name: "Boleto", color: "#fbbf24", amount: groupedStatuses.filter((g) => g.summary.startsWith("BOLETO")).flatMap((g) => g.items).reduce((n, x) => n + x.amountCents, 0) },
                    { name: "Outros", color: "#34d399", amount: groupedStatuses.filter((g) => !/^(PIX|CARTÃO|BOLETO)/.test(g.summary)).flatMap((g) => g.items).reduce((n, x) => n + x.amountCents, 0) }
                  ];
                  return <>
                    <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-[#273650]" aria-label="Distribuição percentual da receita">
                      {buckets.map((bucket) => <div key={bucket.name} style={{ width: `${totalPaidAmountCents > 0 ? (bucket.amount / totalPaidAmountCents) * 100 : 0}%`, backgroundColor: bucket.color }} />)}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                      {buckets.map((bucket) => <div key={bucket.name} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: bucket.color }} /><span className="text-[#c3d0e3]">{bucket.name}</span><span className="ml-auto font-mono text-[10px] text-[#91a1bb]">{totalPaidAmountCents ? ((bucket.amount / totalPaidAmountCents) * 100).toFixed(1) : "0.0"}%</span></div>)}
                    </div>
                  </>;
                })()}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#1c2940] bg-[#0b1325] px-5 py-3 sm:px-7">
              <p className="text-xs text-[#9aacbf]"><span className="mr-2 text-cyan-400">▽</span> Exibindo <strong className="text-[#dce7f7]">{groupedStatuses.length} modalidades</strong> e seus detalhamentos contábeis</p>
              <input aria-label="Buscar canal, conta ou convênio" placeholder="⌕  Buscar canal, conta ou convênio..." value={receiptSearch} onChange={(event) => setReceiptSearch(event.target.value)}
                className="w-full rounded-lg border border-[#2b3b58] bg-[#172139] px-3 py-2 text-xs text-[#edf4ff] placeholder:text-[#71839e] focus:border-cyan-500 focus:outline-none sm:w-80" />
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain bg-[#0c1222] px-5 py-6 sm:px-7">
              {(() => {
                const normalized = receiptSearch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
                const visible = groupedStatuses.map((group) => ({
                  ...group,
                  items: normalized ? group.items.filter((item) => `${group.summary} ${item.systemLabel}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").includes(normalized)) : group.items
                })).filter((group) => !normalized || group.items.length > 0);
                const sections = [
                  { title: "ECOSSISTEMA PIX", description: "Liquidação imediata via arranjo BACEN", tag: "Instantâneo", color: "#22c8e3", groups: visible.filter((g) => g.summary.startsWith("PIX")) },
                  { title: "CARTÕES DE CRÉDITO E DÉBITO", description: "Processamento via adquirentes e TEF", tag: "Adquirentes & TEF", color: "#818cf8", groups: visible.filter((g) => g.summary.startsWith("CARTÃO")) },
                  { title: "BOLETOS BANCÁRIOS", description: "Recebimentos por compensação bancária", tag: "Compensação", color: "#fbbf24", groups: visible.filter((g) => g.summary.startsWith("BOLETO")) },
                  { title: "OUTRAS MODALIDADES", description: "Demais métodos de recebimento", tag: "Outros canais", color: "#34d399", groups: visible.filter((g) => !/^(PIX|CARTÃO|BOLETO)/.test(g.summary)) }
                ];
                return sections.filter((section) => section.groups.length > 0).map((section) => {
                  const amount = section.groups.flatMap((g) => g.items).reduce((n, item) => n + item.amountCents, 0);
                  const count = section.groups.flatMap((g) => g.items).reduce((n, item) => n + item.value, 0);
                  return <article key={section.title} className="overflow-hidden rounded-2xl border border-[#26334d] bg-[#101729]">
                    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#25314a] bg-gradient-to-r from-[#112438] to-[#121a31] px-5 py-5">
                      <div className="flex items-start gap-3">
                        <span className="mt-2 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: section.color, boxShadow: `0 0 0 5px ${section.color}20` }} />
                        <div><div className="flex flex-wrap items-center gap-3"><h5 className="text-sm font-bold tracking-wide">{section.title}</h5><span className="rounded border px-2 py-1 text-[10px]" style={{ color: section.color, borderColor: `${section.color}40`, backgroundColor: `${section.color}12` }}>{section.tag}</span></div><p className="mt-2 text-xs text-[#91a1bb]">{section.description}</p></div>
                      </div>
                      <div className="flex gap-6 text-right text-xs"><div><p className="text-[#91a1bb]">Total de Parcelas</p><p className="mt-1 font-mono font-semibold">{count.toLocaleString("pt-BR")} parcelas</p></div><div><p className="text-[#91a1bb]">Subtotal</p><p className="mt-1 font-mono text-base font-bold" style={{ color: section.color }}>{formatCurrencyBR(amount)}</p></div></div>
                    </header>
                    <div className="grid divide-y divide-[#25314a] lg:divide-x lg:divide-y-0" style={{ gridTemplateColumns: `repeat(${Math.min(section.groups.length, 3)}, minmax(0, 1fr))` }}>
                      {section.groups.map((group) => <div key={group.summary} className="min-w-0 p-4">
                        <div className="flex flex-wrap justify-between gap-2 border-b border-[#23304a] pb-3 text-xs font-semibold"><span>{group.summary}</span><span className="font-mono">{formatCurrencyBR(group.items.reduce((n, x) => n + x.amountCents, 0))}</span></div>
                        <p className="mt-2 text-xs text-[#91a1bb]">{group.items.reduce((n, x) => n + x.value, 0).toLocaleString("pt-BR")} parcelas processadas</p>
                        <div className="mt-3 space-y-2">{group.items.map((item) => <div key={item.label} className="rounded-xl border border-[#24314a] bg-[#0c1425] p-3">
                          <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="min-w-0 flex-1 text-[#d5e0ef]">{item.systemLabel}</span><span className="font-mono font-semibold">{formatCurrencyBR(item.amountCents)}</span></div>
                          <div className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-[#91a1bb]"><span>{item.value.toLocaleString("pt-BR")} parcelas</span><span>Associados: {item.associateCount.toLocaleString("pt-BR")}</span></div>
                        </div>)}</div>
                      </div>)}
                    </div>
                  </article>;
                });
              })()}
            </div>
            <footer className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-t border-[#1c2940] bg-[#070d19] px-5 py-4 sm:px-7">
              <p className="text-xs text-[#91a1bb]"><span className="mr-2 text-cyan-400">ⓘ</span><strong className="font-medium text-[#d4deed]">Nota Contábil:</strong> ABERTO não é exibido nesta modal porque possui um card dedicado no Dashboard.</p>
              <div className="flex gap-3"><button type="button" onClick={() => window.print()} className="rounded-lg border border-[#2b3b58] bg-[#172139] px-4 py-2.5 text-xs font-semibold text-[#c5d1e2] hover:bg-[#233454]">Imprimir Resumo</button><button type="button" onClick={() => setModalOpen(false)} className="rounded-lg bg-cyan-500 px-4 py-2.5 text-xs font-bold text-[#07101b] hover:bg-cyan-400">Concluir Visualização</button></div>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

export function DashboardDonutCharts({
  paid,
  unpaid,
  paidAmountCents,
  pendingAmountCents,
  utilizationPercentage,
  receiptStatuses = [],
  historyScope = "all"
}: {
  paid: number;
  unpaid: number;
  paidAmountCents: number;
  pendingAmountCents: number;
  utilizationPercentage: number;
  receiptStatuses?: DashboardReceiptStatus[];
  historyScope?: string;
}) {
  const averageTicketAmountCents = calculateAverageTicketCents(paidAmountCents, paid);
  const [previousTicketCents, setPreviousTicketCents] = useState<number | null>(null);
  const [ticketHistory, setTicketHistory] = useState<number[]>([]);

  useEffect(() => {
    const scopeKey = encodeURIComponent(historyScope || "all");
    const storageKey = `dashboard-metric-last:ticket-medio:${scopeKey}`;
    try {
      const historyKey = `dashboard-metric-history:ticket-medio:${scopeKey}`;
      const savedHistory = JSON.parse(window.localStorage.getItem(historyKey) ?? "[]");
      const history = Array.isArray(savedHistory)
        ? savedHistory.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        : [];
      if (history.length === 0) {
        const legacyValue = Number(window.localStorage.getItem(storageKey));
        if (Number.isFinite(legacyValue) && legacyValue !== averageTicketAmountCents) history.push(legacyValue);
      }
      const lastValue = history.at(-1) ?? null;
      const nextHistory = lastValue === averageTicketAmountCents
        ? history
        : [...history, averageTicketAmountCents].slice(-12);
      window.localStorage.setItem(historyKey, JSON.stringify(nextHistory));
      window.localStorage.setItem(storageKey, String(averageTicketAmountCents));
      // Este efeito hidrata o histórico persistido no navegador.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviousTicketCents(nextHistory.length > 1 ? nextHistory.at(-2) ?? null : null);
      setTicketHistory(nextHistory);
    } catch {
      setPreviousTicketCents(null);
      setTicketHistory([averageTicketAmountCents]);
    }
  }, [averageTicketAmountCents, historyScope]);

  const ticketVariation = previousTicketCents && previousTicketCents !== 0
    ? ((averageTicketAmountCents - previousTicketCents) / previousTicketCents) * 100
    : null;
  const wavePath = useMemo(() => {
    const values = ticketHistory.length > 0 ? ticketHistory : [averageTicketAmountCents];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const points = values.map((value, index) => ({
      x: values.length === 1 ? 132 : (index / (values.length - 1)) * 264,
      y: range === 0 ? 28 : 44 - ((value - min) / range) * 32
    }));
    if (points.length === 1) return "M0,28 Q66,28 132,28 T264,28";
    let path = `M${points[0].x},${points[0].y}`;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      path += ` Q${previous.x},${previous.y} ${(previous.x + current.x) / 2},${(previous.y + current.y) / 2}`;
    }
    const last = points[points.length - 1];
    return `${path} Q${last.x},${last.y} ${last.x},${last.y}`;
  }, [averageTicketAmountCents, ticketHistory]);

  return (
    <div className="grid h-full auto-rows-fr gap-4 lg:grid-cols-2 lg:grid-rows-2">
      <DonutChart
        title="Aproveitamento"
        centerValue={`${utilizationPercentage.toLocaleString("pt-BR", {
          maximumFractionDigits: 2
        })}%`}
        values={[
          { label: "Pagos", value: paid, color: "#13ad9f" },
          { label: "Nao pagos", value: unpaid, color: "#c75b55" }
        ]}
      />

      <DonutChart
        title="Valores"
        centerValue={formatCurrencyBR(paidAmountCents + pendingAmountCents)}
        values={[
          { label: "Valor pago", value: paidAmountCents, color: "#5578d9" },
          { label: "Valor pendente", value: pendingAmountCents, color: "#c75b55" }
        ]}
        formatter={formatCurrencyBR}
        compactCenterValue
      />

      <article className={lowerChartCardClassName}>
        <h3 className="flex items-center gap-2 text-base font-semibold text-primary "><ChartTitleIcon type="ticket" />Ticket medio da campanha</h3>
        <p className="mt-1 text-sm text-secondary ">
          Valor medio pago por pagamento confirmado.
        </p>
        <div className="mt-3 flex flex-col items-center justify-center rounded-2xl border border-subtle bg-surface-secondary px-6 py-5 text-center shadow-[inset_0_1px_18px_rgba(16,196,174,0.06)]  ">
          <div className="flex items-baseline justify-center gap-2 whitespace-nowrap">
            <span className="text-[2.15rem] font-semibold leading-none text-brand">{formatCurrencyBR(averageTicketAmountCents)}</span>
            <span className={`text-xs font-semibold ${ticketVariation === null || ticketVariation === 0 ? "text-muted " : ticketVariation > 0 ? "text-[#159b69] dark:text-[#72f0bc]" : "text-[#d94352] dark:text-[#ff9ba3]"}`}>
              ({ticketVariation === null ? "—" : `${ticketVariation > 0 ? "+" : ""}${ticketVariation.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`})
            </span>
          </div>
          <p className="mt-2 max-w-[20rem] text-sm text-secondary ">
            {formatCurrencyBR(paidAmountCents)} em {paid.toLocaleString("pt-BR")} pagamentos
          </p>
          <div className="mt-4 w-full max-w-[18rem] border-t border-subtle pt-3 ">
            <svg viewBox="0 0 264 52" className={`h-12 w-full ${ticketVariation !== null && ticketVariation < 0 ? "text-[#FF5B5B]" : "text-[#00E5C3]"}`} preserveAspectRatio="none" aria-label="Variação do ticket médio" role="img">
              <path d={wavePath} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M0,50 H264" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
            </svg>
            <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted dark:text-muted">Variação do ticket médio</p>
          </div>
        </div>
      </article>

      <ReceiptStatusChart statuses={receiptStatuses} />
    </div>
  );
}
