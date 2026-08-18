"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { useEffect, useMemo, useState } from "react";
import { calculateAverageTicketCents, formatCurrencyBR } from "@/lib/money";
import { ManualDashboardIcon } from "@/components/manual-dashboard-icon";
import type { DashboardReceiptStatus } from "@/lib/metrics";

type ChartValue = {
  label: string;
  value: number;
  color: string;
};

const chartCardClassName =
  "flex h-full min-h-[244px] flex-col rounded-2xl border border-[#c7d8e6] bg-white p-4 shadow-sm transition hover:border-[#00a98f]/70 dark:border-[#284665] dark:bg-[#071b34]/90 dark:shadow-[0_8px_28px_rgba(0,0,0,0.2)] dark:hover:border-[#00E5C3]/70";
const lowerChartCardClassName =
  "flex h-full min-h-[216px] flex-col rounded-2xl border border-[#c7d8e6] bg-white p-4 shadow-sm dark:border-[#284665] dark:bg-[#071b34]/90 dark:shadow-[0_8px_28px_rgba(0,0,0,0.2)]";

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
      <h3 className="flex items-center gap-2 text-base font-semibold text-[#102033] dark:text-[#f1f7ff]">
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
                <span className="text-[#30485d] dark:text-[#c4d3e2]">{item.label}</span>
              </div>
              <div className="text-right font-medium text-[#102033] dark:text-[#edf6ff]">
                {formatter ? formatter(item.value) : item.value.toLocaleString("pt-BR")} {" | "}
                <span className="text-[#6d8396] dark:text-[#8fa7bc]">
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

function ReceiptStatusChart({ statuses }: { statuses: DashboardReceiptStatus[] }) {
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const values = statuses.map((status, index) => ({
    label: status.label,
    value: status.installmentCount,
    amountCents: status.amountCents,
    color: RECEIPT_STATUS_COLORS[index % RECEIPT_STATUS_COLORS.length]
  }));
  const selectedStatus = values.find((status) => status.label === selectedLabel) ?? null;
  const totalInstallments = values.reduce((sum, item) => sum + item.value, 0);
  const totalPaidAmountCents = values.reduce((sum, item) => sum + item.amountCents, 0);
  const totalPaidAmountLabel = formatCurrencyBR(totalPaidAmountCents);
  const centerAmountClassName = totalPaidAmountLabel.length > 17
    ? "text-sm font-bold fill-[#102033] dark:fill-[#edf6ff]"
    : totalPaidAmountLabel.length > 13
      ? "text-base font-bold fill-[#102033] dark:fill-[#edf6ff]"
      : "text-lg font-bold fill-[#102033] dark:fill-[#edf6ff]";

  return (
    <article className={lowerChartCardClassName}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-[#102033] dark:text-[#f1f7ff]"><ChartTitleIcon type="insight" />Recebimentos</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#5d7184] dark:text-[#a9bdd0]">
            <span>Parcelas agrupadas por DescricaoRecebimento.</span>
            {values.length > 0 ? <span className="font-semibold text-[#087eaf] dark:text-[#6edbff]">Clique para detalhar</span> : null}
          </div>
        </div>
      </div>

      {values.length === 0 ? (
        <div className="mt-3 flex flex-1 items-center justify-center rounded-2xl border border-dashed border-[#c7d8e6] bg-[#f7fafc] px-5 text-center text-sm text-[#6d8396] dark:border-[#284665] dark:bg-[#06172c] dark:text-[#829ab1]">
          Nenhum status de recebimento registrado ainda.
        </div>
      ) : (
        <>
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
                  cursor="pointer"
                  onClick={(data) => {
                    const label = data?.payload?.label;
                    if (typeof label === "string") setSelectedLabel(label);
                  }}
                >
                  {values.map((item) => <Cell key={item.label} fill={item.color} />)}
                </Pie>
                <Tooltip
                  formatter={(value, _name, item) => [
                    `${Number(value ?? 0).toLocaleString("pt-BR")} parcela(s)`,
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
        </>
      )}

      {selectedStatus ? (
        <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/65 p-4 sm:p-6" role="presentation" onClick={() => setSelectedLabel(null)}>
          <div className="max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-y-auto rounded-3xl border border-[#c7d8e6] bg-white p-6 shadow-2xl dark:border-[#284665] dark:bg-[#071b34]" role="dialog" aria-modal="true" aria-labelledby="receipt-status-modal-title" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#00a98f]">Detalhamento</p>
                <h4 id="receipt-status-modal-title" className="mt-2 text-xl font-semibold text-[#102033] dark:text-[#f1f7ff]">Status de recebimento</h4>
                <p className="mt-1 text-sm text-[#5d7184] dark:text-[#a9bdd0]">Valores consolidados por DescricaoRecebimento.</p>
              </div>
              <button type="button" onClick={() => setSelectedLabel(null)} className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[#d6e3ef] text-[#5d7184] transition hover:bg-[#f5f8fc] dark:border-[#284665] dark:text-[#c4d3e2] dark:hover:bg-[#10223b]" aria-label="Fechar detalhamento">
                <span aria-hidden="true" className="text-xl leading-none">×</span>
              </button>
            </div>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {values.map((item) => (
                <div key={item.label} className={`rounded-2xl border p-3 ${item.label === selectedStatus.label ? "border-[#00a98f] bg-[#f4fffc] dark:bg-[#0b2b3d]" : "border-[#d6e3ef] dark:border-[#284665]"}`}>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
                    <span className="flex min-w-0 items-start gap-2 break-words text-sm font-medium text-[#30485d] dark:text-[#c4d3e2]"><span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />{item.label}</span>
                    <span className="shrink-0 text-right text-sm font-semibold text-[#102033] dark:text-[#edf6ff]">{item.value.toLocaleString("pt-BR")} parcela(s)</span>
                    <p className="col-span-2 text-sm text-[#5d7184] dark:text-[#a9bdd0]">Equivalente: <strong className="text-[#102033] dark:text-[#edf6ff]">{formatCurrencyBR(item.amountCents)}</strong></p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </article>
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
          { label: "Pagos", value: paid, color: "#22D58C" },
          { label: "Nao pagos", value: unpaid, color: "#FF5B5B" }
        ]}
      />

      <DonutChart
        title="Valores"
        centerValue={formatCurrencyBR(paidAmountCents + pendingAmountCents)}
        values={[
          { label: "Valor pago", value: paidAmountCents, color: "#00B8FF" },
          { label: "Valor pendente", value: pendingAmountCents, color: "#FF5B5B" }
        ]}
        formatter={formatCurrencyBR}
        compactCenterValue
      />

      <article className={lowerChartCardClassName}>
        <h3 className="flex items-center gap-2 text-base font-semibold text-[#102033] dark:text-[#f1f7ff]"><ChartTitleIcon type="ticket" />Ticket medio da campanha</h3>
        <p className="mt-1 text-sm text-[#5d7184] dark:text-[#a9bdd0]">
          Valor medio pago por pagamento confirmado.
        </p>
        <div className="mt-3 flex flex-col items-center justify-center rounded-2xl border border-[#c7d8e6] bg-[#f5f8fc] px-6 py-5 text-center shadow-[inset_0_1px_18px_rgba(16,196,174,0.06)] dark:border-[#284665] dark:bg-[#06172c]">
          <div className="flex items-baseline justify-center gap-2 whitespace-nowrap">
            <span className="text-[2.15rem] font-semibold leading-none text-[#13d7b5]">{formatCurrencyBR(averageTicketAmountCents)}</span>
            <span className={`text-xs font-semibold ${ticketVariation === null || ticketVariation === 0 ? "text-[#6d8396] dark:text-[#8fa7bc]" : ticketVariation > 0 ? "text-[#159b69] dark:text-[#72f0bc]" : "text-[#d94352] dark:text-[#ff9ba3]"}`}>
              ({ticketVariation === null ? "—" : `${ticketVariation > 0 ? "+" : ""}${ticketVariation.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`})
            </span>
          </div>
          <p className="mt-2 max-w-[20rem] text-sm text-[#5d7184] dark:text-[#b6c9dc]">
            {formatCurrencyBR(paidAmountCents)} em {paid.toLocaleString("pt-BR")} pagamentos
          </p>
          <div className="mt-4 w-full max-w-[18rem] border-t border-[#d6e3ef] pt-3 dark:border-[#284665]">
            <svg viewBox="0 0 264 52" className={`h-12 w-full ${ticketVariation !== null && ticketVariation < 0 ? "text-[#FF5B5B]" : "text-[#00E5C3]"}`} preserveAspectRatio="none" aria-label="Variação do ticket médio" role="img">
              <path d={wavePath} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M0,50 H264" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
            </svg>
            <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[#6d8396] dark:text-[#7893ab]">Variação do ticket médio</p>
          </div>
        </div>
      </article>

      <ReceiptStatusChart statuses={receiptStatuses} />
    </div>
  );
}
