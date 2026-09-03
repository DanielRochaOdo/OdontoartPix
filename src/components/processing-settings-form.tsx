"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ProcessingConfig } from "@/lib/processing-config";
import type { ProcessingPresetKey } from "@/lib/processing-presets";

type IntervalMinutes = 1 | 5 | 30 | 60 | 120;

type Props = {
  presets: Record<ProcessingPresetKey, ProcessingConfig>;
  selectedPresetKey: ProcessingPresetKey | null;
  scheduledIntervalMinutes: IntervalMinutes;
  automaticSyncEnabled: boolean;
};

const labels: Record<ProcessingPresetKey, string> = {
  conservador: "Conservador",
  mediano: "Mediano",
  agressivo: "Agressivo"
};

const descriptions: Record<ProcessingPresetKey, string> = {
  conservador: "Menor pressão no ERP e operação mais cautelosa.",
  mediano: "Equilíbrio entre segurança operacional e velocidade.",
  agressivo: "Perfil de alta performance validado em produção."
};

function technicalRows(config: ProcessingConfig) {
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
  scheduledIntervalMinutes,
  automaticSyncEnabled
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<ProcessingPresetKey | null>(selectedPresetKey);
  const [interval, setInterval] = useState<IntervalMinutes>(scheduledIntervalMinutes);
  const [automaticEnabled, setAutomaticEnabled] = useState(automaticSyncEnabled);
  const [busy, setBusy] = useState(false);
  const [automaticBusy, setAutomaticBusy] = useState(false);
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
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ presetKey: selected, scheduledIntervalMinutes: interval })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setMessage(payload?.error?.message ?? "Não foi possível salvar a configuração.");
        return;
      }
      setMessage(payload?.message ?? "Configuração atualizada.");
      router.refresh();
    } catch {
      setMessage("Falha de comunicação ao salvar configurações.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleAutomaticSync() {
    const nextEnabled = !automaticEnabled;
    setAutomaticBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/configuracoes/processamento", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          automaticSyncEnabled: nextEnabled,
          scheduledIntervalMinutes: interval
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setMessage(payload?.error?.message ?? "Não foi possível alterar a sincronização automática.");
        return;
      }
      setAutomaticEnabled(payload.data?.automaticSyncEnabled === true);
      setMessage(payload?.message ?? "Sincronização automática atualizada.");
      router.refresh();
    } catch {
      setMessage("Falha de comunicação ao alterar a sincronização automática.");
    } finally {
      setAutomaticBusy(false);
    }
  }

  return (
    <>
      <section id="processamento" className="mt-6 rounded-2xl border border-default bg-surface-primary p-5 shadow-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">Processamento</p>
          <h2 className="mt-1 text-xl font-semibold text-primary">Perfil operacional</h2>
          <p className="mt-1 text-sm text-secondary">
            Escolha o comportamento do pipeline. Os parâmetros técnicos ficam recolhidos por padrão.
          </p>
        </div>

        {selectedPresetKey === null ? (
          <div className="mt-4 rounded-xl border border-warning bg-warning-soft px-4 py-3 text-sm text-warning">
            A configuração atual é personalizada. Selecione um perfil somente se quiser substituí-la.
          </div>
        ) : null}

        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          {(Object.keys(presets) as ProcessingPresetKey[]).map((key) => {
            const config = presets[key];
            const active = selected === key;
            return (
              <article key={key} className={`rounded-2xl border p-4 transition ${active ? "border-brand bg-brand-soft" : "border-default bg-surface-secondary"}`}>
                <button type="button" onClick={() => setSelected(key)} className="w-full text-left">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-primary">{labels[key]}</h3>
                      <p className="mt-1 text-sm text-secondary">{descriptions[key]}</p>
                    </div>
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${active ? "bg-brand text-inverse" : "bg-surface-tertiary text-secondary"}`}>
                      {active ? "Selecionado" : "Disponível"}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    <div><p className="text-[10px] uppercase text-muted">Workers</p><p className="mt-1 font-semibold text-primary">{config.workerCount}</p></div>
                    <div><p className="text-[10px] uppercase text-muted">Bloco</p><p className="mt-1 font-semibold text-primary">{config.claimBatchSize}</p></div>
                    <div><p className="text-[10px] uppercase text-muted">ERP</p><p className="mt-1 font-semibold text-primary">{config.erpConcurrency}</p></div>
                  </div>
                </button>
                <details className="mt-4 border-t border-subtle pt-3">
                  <summary className="cursor-pointer text-xs font-semibold text-brand">Ver parâmetros técnicos</summary>
                  <div className="mt-3 grid gap-2 text-xs">
                    {technicalRows(config).map(([label, value]) => (
                      <div key={label} className="flex items-center justify-between gap-3">
                        <span className="text-muted">{label}</span>
                        <span className="font-medium text-primary">{value}</span>
                      </div>
                    ))}
                  </div>
                </details>
              </article>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" onClick={apply} disabled={busy || automaticBusy || !selected} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? "Salvando..." : "Aplicar perfil"}
          </button>
          {message ? <p className="text-sm text-secondary">{message}</p> : null}
        </div>
      </section>

      <section id="automacao" className="mt-6 rounded-2xl border border-default bg-surface-primary p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">Automação</p>
            <div className="mt-1 flex items-center gap-2">
              <h2 className="text-xl font-semibold text-primary">Sincronização automática</h2>
              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${automaticEnabled ? "bg-success-soft text-success" : "bg-surface-tertiary text-secondary"}`}>
                {automaticEnabled ? "Ativada" : "Desativada"}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-secondary">
              Controle quando o sistema inicia a sincronização geral sem intervenção manual.
            </p>
          </div>
          <button type="button" onClick={toggleAutomaticSync} disabled={busy || automaticBusy} aria-pressed={automaticEnabled} className={`rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${automaticEnabled ? "border border-danger bg-danger-soft text-danger" : "bg-brand text-inverse"}`}>
            {automaticBusy ? "Salvando..." : automaticEnabled ? "Desativar" : "Ativar"}
          </button>
        </div>

        <div className="mt-5 max-w-md rounded-xl border border-default bg-surface-secondary p-4">
          <label className="text-sm font-medium text-primary">
            Frequência
            <select value={interval} onChange={(event) => setInterval(Number(event.target.value) as IntervalMinutes)} disabled={busy || automaticBusy} className="mt-2 w-full rounded-lg border border-default bg-surface-primary px-3 py-2.5 text-sm text-primary">
              <option value={1}>A cada 1 minuto</option>
              <option value={5}>A cada 5 minutos</option>
              <option value={30}>A cada 30 minutos</option>
              <option value={60}>A cada 1 hora</option>
              <option value={120}>A cada 2 horas</option>
            </select>
          </label>
          <p className="mt-2 text-xs text-muted">Ao ativar, o próximo ciclo será contado a partir da ativação.</p>
        </div>
      </section>
    </>
  );
}
