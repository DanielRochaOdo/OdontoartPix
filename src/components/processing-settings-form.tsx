"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ProcessingConfig } from "@/lib/processing-config";
import type { ProcessingPresetKey } from "@/lib/processing-presets";

type Props = {
  presets: Record<ProcessingPresetKey, ProcessingConfig>;
  selectedPresetKey: ProcessingPresetKey | null;
  scheduledIntervalMinutes: 1 | 5 | 30 | 60 | 120;
};

const labels: Record<ProcessingPresetKey, string> = {
  conservador: "Conservador",
  mediano: "Mediano",
  agressivo: "Agressivo"
};

const descriptions: Record<ProcessingPresetKey, string> = {
  conservador: "Menor pressao no ERP, mais tolerancia operacional e menor throughput.",
  mediano: "Perfil padrao balanceado entre velocidade e estabilidade.",
  agressivo: "Concorrência dobrada em relação ao perfil mediano, com ondas de até 30 registros."
};

function rowsForConfig(config: ProcessingConfig) {
  return [
    ["Workers", String(config.workerCount)],
    ["Block size", String(config.claimBatchSize)],
    ["ERP concurrency", String(config.erpConcurrency)],
    ["Persistence concurrency", String(config.persistenceConcurrency)],
    ["Persistence batch", String(config.persistenceBatchSize)],
    ["Max buffered", String(config.maxBufferedResults)],
    ["Connect timeout", `${config.httpConnectTimeoutMs} ms`],
    ["Read timeout", `${config.httpReadTimeoutMs} ms`],
    ["Max attempts", String(config.maxAttemptsPerItem)],
    ["Stale heartbeat", `${config.staleHeartbeatMs} ms`],
    ["Cycle budget", `${config.workerCycleBudgetMs} ms`],
    ["Lease", `${config.globalLockLeaseSeconds} s`],
    ["Productive delay", `${config.productiveDelayMs} ms`],
    ["Page size", String(config.maxPageSize)],
    ["Max pages", String(config.maxPagesPerOperation)]
  ];
}

export function ProcessingSettingsForm({
  presets,
  selectedPresetKey,
  scheduledIntervalMinutes
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<ProcessingPresetKey | null>(selectedPresetKey);
  const [interval, setInterval] = useState<1 | 5 | 30 | 60 | 120>(scheduledIntervalMinutes);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function apply() {
    if (!selected) {
      setMessage("Selecione um perfil antes de aplicar.");
      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch("/api/configuracoes/processamento", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ presetKey: selected, scheduledIntervalMinutes: interval })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setMessage(payload?.error?.message ?? "Nao foi possivel salvar a configuracao.");
        return;
      }

      setMessage(payload?.message ?? "Configuracao atualizada.");
      router.refresh();
    } catch {
      setMessage("Falha de comunicacao ao salvar configuracoes.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-[#284665] dark:bg-[#071b34]/90">
      <div>
        <h2 className="text-lg font-semibold">Perfis de processamento</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300">
          Selecione o perfil operacional e aplique sem editar variaveis manualmente.
        </p>
      </div>

      {selectedPresetKey === null ? (
        <div className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-200">
          A configuracao atual e personalizada e nao corresponde exatamente a nenhum dos perfis disponiveis.
          Selecione um perfil somente se quiser substituir a configuracao atual.
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        {(Object.keys(presets) as ProcessingPresetKey[]).map((key) => {
          const config = presets[key];
          const active = selected === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelected(key)}
              className={`rounded-2xl border p-4 text-left transition ${
                active
                  ? "border-emerald-500 bg-emerald-50 shadow-sm dark:border-emerald-500 dark:bg-emerald-950/40"
                  : "border-slate-200 bg-slate-50 hover:border-slate-300 dark:border-[#284665] dark:bg-[#0b243d] dark:hover:border-slate-500"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{labels[key]}</h3>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{descriptions[key]}</p>
                </div>
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${
                    active
                      ? "bg-emerald-700 text-white"
                      : "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200"
                  }`}
                >
                  {active ? "Selecionado" : "Disponivel"}
                </span>
              </div>

              <div className="mt-4 grid gap-2 text-sm text-slate-700 dark:text-slate-200">
                {rowsForConfig(config).map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3">
                    <span className="text-slate-500 dark:text-slate-400">{label}</span>
                    <span className="font-medium text-slate-900 dark:text-slate-100">{value}</span>
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <span>Frequência automática</span>
          <select
            value={interval}
            onChange={(event) => setInterval(Number(event.target.value) as 1 | 5 | 30 | 60 | 120)}
            disabled={busy}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-[#34516f] dark:bg-[#0b243d] dark:text-slate-100"
          >
            <option value={1}>A cada 1 minuto</option>
            <option value={5}>A cada 5 minutos</option>
            <option value={30}>A cada 30 minutos</option>
            <option value={60}>A cada 1 hora</option>
            <option value={120}>A cada 2 horas</option>
          </select>
        </label>
        <button
          type="button"
          onClick={apply}
          disabled={busy || !selected}
          className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Salvando..." : "Aplicar perfil"}
        </button>
        {message ? <p className="text-sm text-slate-600 dark:text-slate-300">{message}</p> : null}
      </div>
    </section>
  );
}
