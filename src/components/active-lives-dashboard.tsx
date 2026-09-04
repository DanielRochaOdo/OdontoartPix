"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

type Snapshot = {
  id: string;
  totalVidasAtivas: number;
  totalTitularesAtivos: number;
  totalDependentesAtivos: number;
  dataConsulta: string;
  collectedAt: string;
};

type Growth = { absolute: number; percentage: number | null };

type DashboardData = {
  latest: Snapshot | null;
  period: {
    from: string;
    to: string;
    first: Snapshot | null;
    last: Snapshot | null;
    growth: {
      totalVidasAtivas: Growth;
      totalTitularesAtivos: Growth;
      totalDependentesAtivos: Growth;
    };
  };
  trend: Snapshot[];
  sampling: "hour" | "day";
  collectionIntervalMinutes: 5;
};

type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: { message?: string };
};

const numberFormat = new Intl.NumberFormat("pt-BR");
const percentFormat = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function todayInFortaleza() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
  return shifted.toISOString().slice(0, 10);
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatPeriodDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !payload?.success || payload.data === undefined) {
    throw new Error(payload?.error?.message || "Não foi possível concluir a operação.");
  }
  return payload.data;
}

function GrowthBadge({ growth }: { growth: Growth }) {
  const positive = growth.absolute > 0;
  const negative = growth.absolute < 0;
  const sign = positive ? "+" : "";
  const classes = positive
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
    : negative
      ? "border-rose-500/30 bg-rose-500/10 text-rose-500"
      : "border-default bg-surface-secondary text-secondary";

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${classes}`}>
      {sign}{numberFormat.format(growth.absolute)}
      {growth.percentage !== null ? ` · ${sign}${percentFormat.format(growth.percentage)}%` : ""}
    </span>
  );
}

function MetricCard({
  label,
  value,
  growth,
  description
}: {
  label: string;
  value: number;
  growth?: Growth;
  description: string;
}) {
  return (
    <article className="rounded-3xl border border-default bg-surface-primary p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">{label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-primary">{numberFormat.format(value)}</p>
        </div>
        {growth ? <GrowthBadge growth={growth} /> : null}
      </div>
      <p className="mt-3 text-sm text-secondary">{description}</p>
    </article>
  );
}

export function ActiveLivesDashboard() {
  const today = useMemo(() => todayInFortaleza(), []);
  const [draftRange, setDraftRange] = useState(() => ({
    from: shiftDate(today, -29),
    to: today
  }));
  const [appliedRange, setAppliedRange] = useState(draftRange);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    const search = new URLSearchParams(appliedRange);
    const response = await fetch(`/api/vidas-ativas?${search.toString()}`, {
      method: "GET",
      cache: "no-store"
    });
    const next = await readEnvelope<DashboardData>(response);
    setData(next);
  }, [appliedRange]);

  const collect = useCallback(async (force: boolean, showBusy = true) => {
    if (showBusy) setCollecting(true);
    try {
      const response = await fetch("/api/vidas-ativas/coletar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force })
      });
      await readEnvelope(response);
    } finally {
      if (showBusy) setCollecting(false);
    }
  }, []);

  const refresh = useCallback(async (forceCollection = false, showBusy = true) => {
    setError(null);
    try {
      await collect(forceCollection, showBusy);
      await loadDashboard();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Falha ao atualizar vidas ativas.");
      try {
        await loadDashboard();
      } catch {
        // Mantém o erro original da coleta, que normalmente é mais útil para diagnóstico.
      }
    } finally {
      setLoading(false);
    }
  }, [collect, loadDashboard]);

  useEffect(() => {
    void refresh(false, false);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh(false, false);
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const chartData = useMemo(() => {
    return (data?.trend ?? []).map((snapshot) => {
      const date = new Date(snapshot.dataConsulta);
      const label = new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Fortaleza",
        day: "2-digit",
        month: "2-digit",
        ...(data?.sampling === "hour" ? { hour: "2-digit", minute: "2-digit" } : {})
      }).format(date);
      return { ...snapshot, label };
    });
  }, [data]);

  const latest = data?.latest;
  const growth = data?.period.growth;
  const holdersShare = latest?.totalVidasAtivas
    ? (latest.totalTitularesAtivos / latest.totalVidasAtivas) * 100
    : 0;
  const dependentsShare = latest?.totalVidasAtivas
    ? (latest.totalDependentesAtivos / latest.totalVidasAtivas) * 100
    : 0;

  function applyRange() {
    if (!draftRange.from || !draftRange.to || draftRange.from > draftRange.to) {
      setError("Selecione um período válido.");
      return;
    }
    setError(null);
    setLoading(true);
    setAppliedRange(draftRange);
  }

  return (
    <div className="min-h-screen bg-app px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <header className="flex flex-col gap-4 rounded-3xl border border-default bg-surface-primary p-6 shadow-sm xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-500">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Atualização a cada 5 min
              </span>
              <span className="text-xs text-secondary">Odontoart online · vidas ativas</span>
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-primary sm:text-4xl">Contador de vidas ativas</h1>
            <p className="mt-2 max-w-2xl text-sm text-secondary sm:text-base">
              Acompanhe o total atual, titulares, dependentes e a evolução histórica das vidas ativas.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void refresh(true, true)}
            disabled={collecting}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl bg-[#00b89c] px-5 text-sm font-semibold text-[#03231f] transition hover:bg-[#27d3b6] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${collecting ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M20 6v5h-5" />
              <path d="M4 18v-5h5" />
              <path d="M18.5 9A7 7 0 0 0 6 6.5L4 11M20 13l-2 4.5A7 7 0 0 1 5.5 15" />
            </svg>
            {collecting ? "Consultando..." : "Atualizar agora"}
          </button>
        </header>

        {error ? (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-500">
            {error}
          </div>
        ) : null}

        <section className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <article className="relative overflow-hidden rounded-[32px] border border-[#18cbb0]/25 bg-[radial-gradient(circle_at_top_right,rgba(0,229,195,0.16),transparent_38%),linear-gradient(135deg,#07342f_0%,#062421_55%,#041a18_100%)] p-6 text-white shadow-[0_24px_70px_rgba(2,25,22,0.22)] sm:p-8">
            <div className="relative z-10">
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[#83e7d4]">Total de vidas ativas</p>
              <div className="mt-5 flex flex-wrap items-end gap-4">
                <p className="text-6xl font-semibold tracking-[-0.05em] sm:text-7xl lg:text-8xl">
                  {loading && !latest ? "—" : numberFormat.format(latest?.totalVidasAtivas ?? 0)}
                </p>
                {growth ? <GrowthBadge growth={growth.totalVidasAtivas} /> : null}
              </div>
              <p className="mt-5 text-sm text-[#a9d8d0]">
                Data da consulta: <strong className="font-semibold text-white">{formatDateTime(latest?.dataConsulta)}</strong>
              </p>
              <p className="mt-1 text-xs text-[#73aa9f]">Último snapshot salvo: {formatDateTime(latest?.collectedAt)}</p>
            </div>
          </article>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
            <MetricCard
              label="Titulares ativos"
              value={latest?.totalTitularesAtivos ?? 0}
              growth={growth?.totalTitularesAtivos}
              description={`${percentFormat.format(holdersShare)}% do total atual`}
            />
            <MetricCard
              label="Dependentes ativos"
              value={latest?.totalDependentesAtivos ?? 0}
              growth={growth?.totalDependentesAtivos}
              description={`${percentFormat.format(dependentsShare)}% do total atual`}
            />
          </div>
        </section>

        <section className="rounded-3xl border border-default bg-surface-primary p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Análise de crescimento</p>
              <h2 className="mt-2 text-xl font-semibold text-primary">Variação no período escolhido</h2>
              <p className="mt-1 text-sm text-secondary">
                Compara o primeiro e o último snapshot disponível entre as datas selecionadas.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <label className="grid gap-1.5 text-xs font-medium text-secondary">
                De
                <input
                  type="date"
                  value={draftRange.from}
                  max={draftRange.to}
                  onChange={(event) => setDraftRange((range) => ({ ...range, from: event.target.value }))}
                  className="h-10 rounded-xl border border-default bg-surface-secondary px-3 text-sm text-primary outline-none transition focus:border-[#00b89c]"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-secondary">
                Até
                <input
                  type="date"
                  value={draftRange.to}
                  min={draftRange.from}
                  onChange={(event) => setDraftRange((range) => ({ ...range, to: event.target.value }))}
                  className="h-10 rounded-xl border border-default bg-surface-secondary px-3 text-sm text-primary outline-none transition focus:border-[#00b89c]"
                />
              </label>
              <button
                type="button"
                onClick={applyRange}
                className="h-10 self-end rounded-xl border border-default bg-surface-secondary px-4 text-sm font-semibold text-primary transition hover:bg-surface-hover"
              >
                Aplicar período
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-default bg-surface-secondary p-4">
              <p className="text-xs text-secondary">Vidas ativas</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-lg font-semibold text-primary">{growth ? `${growth.totalVidasAtivas.absolute >= 0 ? "+" : ""}${numberFormat.format(growth.totalVidasAtivas.absolute)}` : "—"}</span>
                {growth ? <GrowthBadge growth={growth.totalVidasAtivas} /> : null}
              </div>
            </div>
            <div className="rounded-2xl border border-default bg-surface-secondary p-4">
              <p className="text-xs text-secondary">Titulares</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-lg font-semibold text-primary">{growth ? `${growth.totalTitularesAtivos.absolute >= 0 ? "+" : ""}${numberFormat.format(growth.totalTitularesAtivos.absolute)}` : "—"}</span>
                {growth ? <GrowthBadge growth={growth.totalTitularesAtivos} /> : null}
              </div>
            </div>
            <div className="rounded-2xl border border-default bg-surface-secondary p-4">
              <p className="text-xs text-secondary">Dependentes</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-lg font-semibold text-primary">{growth ? `${growth.totalDependentesAtivos.absolute >= 0 ? "+" : ""}${numberFormat.format(growth.totalDependentesAtivos.absolute)}` : "—"}</span>
                {growth ? <GrowthBadge growth={growth.totalDependentesAtivos} /> : null}
              </div>
            </div>
          </div>

          <p className="mt-4 text-xs text-secondary">
            Período aplicado: {formatPeriodDate(appliedRange.from)} a {formatPeriodDate(appliedRange.to)}
            {data?.period.first && data?.period.last
              ? ` · de ${numberFormat.format(data.period.first.totalVidasAtivas)} para ${numberFormat.format(data.period.last.totalVidasAtivas)} vidas`
              : " · ainda sem amostras suficientes"}
          </p>
        </section>

        <section className="grid gap-6 2xl:grid-cols-2">
          <article className="rounded-3xl border border-default bg-surface-primary p-5 shadow-sm sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Evolução</p>
                <h2 className="mt-2 text-xl font-semibold text-primary">Total de vidas ativas</h2>
              </div>
              <span className="rounded-full border border-default bg-surface-secondary px-3 py-1 text-xs text-secondary">
                Amostragem {data?.sampling === "hour" ? "por hora" : "diária"}
              </span>
            </div>
            <div className="mt-6 h-[320px] w-full">
              {chartData.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(117, 151, 145, 0.22)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={54} domain={["auto", "auto"]} />
                    <Tooltip formatter={(value) => numberFormat.format(Number(value ?? 0))} />
                    <Line type="monotone" dataKey="totalVidasAtivas" name="Vidas ativas" stroke="#00c9a8" strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-default bg-surface-secondary text-center text-sm text-secondary">
                  Ainda não há histórico suficiente para desenhar o gráfico.
                </div>
              )}
            </div>
          </article>

          <article className="rounded-3xl border border-default bg-surface-primary p-5 shadow-sm sm:p-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Composição</p>
              <h2 className="mt-2 text-xl font-semibold text-primary">Titulares x dependentes</h2>
            </div>
            <div className="mt-6 h-[320px] w-full">
              {chartData.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="holdersGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#00b8ff" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#00b8ff" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="dependentsGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#00e5c3" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#00e5c3" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(117, 151, 145, 0.22)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={54} domain={["auto", "auto"]} />
                    <Tooltip formatter={(value) => numberFormat.format(Number(value ?? 0))} />
                    <Legend />
                    <Area type="monotone" dataKey="totalTitularesAtivos" name="Titulares" stroke="#00b8ff" fill="url(#holdersGradient)" strokeWidth={2.5} />
                    <Area type="monotone" dataKey="totalDependentesAtivos" name="Dependentes" stroke="#00e5c3" fill="url(#dependentsGradient)" strokeWidth={2.5} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-default bg-surface-secondary text-center text-sm text-secondary">
                  As amostras aparecerão aqui após as primeiras coletas.
                </div>
              )}
            </div>
          </article>
        </section>
      </div>
    </div>
  );
}
