"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { calculateAverageTicketCents, formatCurrencyBR } from "@/lib/money";
import { ManualDashboardIcon } from "@/components/manual-dashboard-icon";

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

export function DashboardDonutCharts({
  paid,
  unpaid,
  paidAmountCents,
  pendingAmountCents,
  utilizationPercentage
}: {
  paid: number;
  unpaid: number;
  paidAmountCents: number;
  pendingAmountCents: number;
  utilizationPercentage: number;
}) {
  const averageTicketAmountCents = calculateAverageTicketCents(paidAmountCents, paid);

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
        <div className="mt-3 flex flex-3 flex-col items-center justify-center rounded-2xl border border-[#284665] bg-[#06172c] px-6 py-6 text-center shadow-[inset_0_1px_18px_rgba(16,196,174,0.06)]">
          <div className="text-[2.15rem] font-semibold leading-none text-[#13d7b5]">
            {formatCurrencyBR(averageTicketAmountCents)}
          </div>
          <p className="mt-4 max-w-[20rem] text-sm text-[#b6c9dc]">
            {formatCurrencyBR(paidAmountCents)} em {paid.toLocaleString("pt-BR")} pagamentos
          </p>
        </div>
      </article>

      <article className="flex h-full min-h-[216px] flex-col rounded-2xl border border-[#284665] bg-[#071b34]/90 p-4 shadow-[0_8px_28px_rgba(0,0,0,0.2)]">
        <h3 className="flex items-center gap-2 text-base font-semibold text-[#102033] dark:text-[#f1f7ff]"><ChartTitleIcon type="insight" />Grafico 4</h3>
        <div className="mt-3 flex flex-1 items-center justify-center rounded-2xl bg-[#06172c] text-sm text-[#829ab1]">
          A definir
        </div>
      </article>
    </div>
  );
}
