"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ProcessingConfig } from "@/lib/processing-config";
import type { ProcessingPresetKey } from "@/lib/processing-presets";

type Props = {
  presets: Record<ProcessingPresetKey, ProcessingConfig>;
  selectedPresetKey: ProcessingPresetKey | null;
};

const labels: Record<ProcessingPresetKey, string> = {
  conservador: "Conservador",
  mediano: "Mediano",
  agressivo: "Agressivo"
};

const descriptions: Record<ProcessingPresetKey, string> = {
  conservador: "Menor pressao no ERP, mais tolerancia operacional e menor throughput.",
  mediano: "Perfil padrao balanceado entre velocidade e estabilidade.",
  agressivo: "Bloco em 120 com ajuste para continuar estavel no processamento."
};

function rowsForConfig(config: ProcessingConfig) {
  return [
    ["Workers", String(config.workerCount)],
    ["Block size", String(config.claimBatchSize)],
    ["Concurrency", String(config.perWorkerConcurrency)],
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
  selectedPresetKey
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<ProcessingPresetKey>(selectedPresetKey ?? "mediano");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function apply() {
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch("/api/configuracoes/processamento", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ presetKey: selected })
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
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">Perfis de processamento</h2>
        <p className="mt-1 text-sm text-slate-500">
          Selecione o perfil operacional e aplique sem editar variaveis manualmente.
        </p>
      </div>

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
                  ? "border-emerald-500 bg-emerald-50 shadow-sm"
                  : "border-slate-200 bg-slate-50 hover:border-slate-300"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">{labels[key]}</h3>
                  <p className="mt-1 text-sm text-slate-600">{descriptions[key]}</p>
                </div>
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${
                    active ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-700"
                  }`}
                >
                  {active ? "Selecionado" : "Disponivel"}
                </span>
              </div>

              <div className="mt-4 grid gap-2 text-sm text-slate-700">
                {rowsForConfig(config).map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">{label}</span>
                    <span className="font-medium text-slate-900">{value}</span>
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={apply}
          disabled={busy}
          className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60"
        >
          {busy ? "Salvando..." : "Aplicar perfil"}
        </button>
        {message ? <p className="text-sm text-slate-600">{message}</p> : null}
      </div>
    </section>
  );
}
