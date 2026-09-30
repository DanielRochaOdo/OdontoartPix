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

    const ordered = RECEIPT_SUMMARY_ORDER.map((summary) => {
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
        <div
          className="fixed inset-0 z-[80] grid place-items-center overflow-hidden bg-slate-950/70 p-2 backdrop-blur-[2px] sm:p-4"
          role="presentation"
          onMouseDown={() => setModalOpen(false)}
        >
          <section
            className="flex max-h-[calc(100dvh-1rem)] w-full max-w-[1480px] min-w-0 flex-col overflow-hidden rounded-3xl border border-subtle bg-surface-primary text-primary shadow-2xl sm:max-h-[calc(100dvh-2rem)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="receipt-status-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex min-w-0 shrink-0 items-start justify-between gap-4 border-b border-subtle px-4 py-4 sm:px-6 sm:py-5">
              <div className="min-w-0">
                <h4 id="receipt-status-modal-title" className="break-words text-xl font-semibold text-primary sm:text-2xl">Status de recebimento</h4>
                <p className="mt-1 break-words text-sm text-secondary">
                  Parcelas agrupadas por tipo de pagamento resumido.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-subtle text-secondary transition hover:bg-surface-secondary"
                aria-label="Fechar status de recebimento"
              >
                <span aria-hidden="true" className="text-2xl leading-none">×</span>
              </button>
            </header>

            <div className="grid shrink-0 gap-3 border-b border-subtle px-4 py-4 sm:grid-cols-2 sm:px-6">
              <div className="min-w-0 rounded-2xl border border-subtle bg-surface-secondary px-4 py-3">
                <p className="text-xs text-secondary">Valor total recebido</p>
                <p className="mt-1 break-words text-xl font-semibold text-primary [overflow-wrap:anywhere]">{totalPaidAmountLabel}</p>
              </div>
              <div className="min-w-0 rounded-2xl border border-subtle bg-surface-secondary px-4 py-3">
                <p className="text-xs text-secondary">Total de parcelas</p>
                <p className="mt-1 text-xl font-semibold text-primary">{totalInstallments.toLocaleString("pt-BR")} parcelas</p>
              </div>
            </div>

            <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-4 sm:px-5">
              <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
                {groupedStatuses.map((group) => {
                  const groupAmount = group.items.reduce((sum, item) => sum + item.amountCents, 0);
                  const groupInstallments = group.items.reduce((sum, item) => sum + item.value, 0);
                  return (
                    <article key={group.summary} className="min-w-0 overflow-hidden rounded-2xl border border-subtle bg-surface-secondary">
                      <div className="flex min-w-0 items-start justify-between gap-3 border-b border-subtle px-3 py-3">
                        <div className="flex min-w-0 items-start gap-2">
                          <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
                          <h5 className="min-w-0 break-words text-sm font-bold text-primary [overflow-wrap:anywhere]">{group.summary}</h5>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-xs font-semibold text-primary">{formatCurrencyBR(groupAmount)}</p>
                          <p className="mt-0.5 text-[11px] text-secondary">{groupInstallments.toLocaleString("pt-BR")} parcelas</p>
                        </div>
                      </div>

                      {group.items.length === 0 ? (
                        <p className="px-3 py-5 text-center text-xs text-muted">Sem registros no filtro atual.</p>
                      ) : (
                        <div className="min-w-0 divide-y divide-subtle">
                          {group.items.map((item) => (
                            <div key={`${group.summary}:${item.label}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-3 py-3">
                              <div className="flex min-w-0 items-start gap-2">
                                <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                                <p className="min-w-0 break-words text-xs font-medium text-secondary [overflow-wrap:anywhere]">{item.systemLabel}</p>
                              </div>
                              <p className="shrink-0 text-right text-xs font-semibold text-primary">{formatCurrencyBR(item.amountCents)}</p>
                              <p className="col-span-2 pl-[18px] text-[11px] text-muted">
                                {item.value.toLocaleString("pt-BR")} parcelas · Associados: {item.associateCount.toLocaleString("pt-BR")}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>

            <footer className="shrink-0 border-t border-subtle px-4 py-3 text-center text-xs text-muted sm:px-6">
              ABERTO não é exibido nesta modal porque possui um card dedicado no Dashboard.
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
