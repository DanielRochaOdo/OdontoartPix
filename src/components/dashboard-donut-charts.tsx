"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { calculateAverageTicketCents, formatCurrencyBR } from "@/lib/money";

type ChartValue = {
  label: string;
  value: number;
  color: string;
};

const chartCardClassName =
  "flex h-full min-h-[244px] flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const lowerChartCardClassName =
  "flex h-full min-h-[216px] flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";

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
      ? "text-sm font-semibold text-slate-900"
      : compactCenterValue
        ? "text-lg font-semibold text-slate-900"
        : "text-xl font-semibold text-slate-900";
  const centerStartY = centerLines.length > 1 ? 44 : 50;

  return (
    <article className={chartCardClassName}>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
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
                backgroundColor: "var(--chart-tooltip-bg, #ffffff)",
                border: "1px solid rgba(148, 163, 184, 0.3)",
                borderRadius: "12px",
                color: "var(--chart-tooltip-fg, #0f172a)"
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
                <span className="text-slate-600">{item.label}</span>
              </div>
              <div className="text-right font-medium text-slate-900">
                {formatter ? formatter(item.value) : item.value.toLocaleString("pt-BR")} {" | "}
                <span className="text-slate-500">
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
          { label: "Pagos", value: paid, color: "#059669" },
          { label: "Nao pagos", value: unpaid, color: "#f59e0b" }
        ]}
      />

      <DonutChart
        title="Valores"
        centerValue={formatCurrencyBR(paidAmountCents + pendingAmountCents)}
        values={[
          { label: "Valor pago", value: paidAmountCents, color: "#2563eb" },
          { label: "Valor pendente", value: pendingAmountCents, color: "#ef4444" }
        ]}
        formatter={formatCurrencyBR}
        compactCenterValue
      />

      <article className={lowerChartCardClassName}>
        <h3 className="text-sm font-semibold text-slate-900">Ticket medio da campanha</h3>
        <p className="mt-1 text-xs text-slate-500">
          Valor medio pago por pagamento confirmado.
        </p>
        <div className="mt-3 flex flex-3 flex-col items-center justify-center rounded-2xl bg-slate-50 px-6 py-6 text-center">
          <div className="text-[2.15rem] font-semibold leading-none text-slate-900">
            {formatCurrencyBR(averageTicketAmountCents)}
          </div>
          <p className="mt-4 max-w-[20rem] text-sm text-slate-600">
            {formatCurrencyBR(paidAmountCents)} em {paid.toLocaleString("pt-BR")} pagamentos
          </p>
        </div>
      </article>

      <article className="flex h-full min-h-[216px] flex-col rounded-2xl border border-dashed border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">Grafico 4</h3>
        <div className="mt-3 flex flex-1 items-center justify-center rounded-2xl bg-slate-50 text-sm text-slate-400">
          A definir
        </div>
      </article>
    </div>
  );
}
