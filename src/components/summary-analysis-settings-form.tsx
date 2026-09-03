"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrencyBR } from "@/lib/money";

function centsToInput(cents: number) {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function inputToCents(value: string) {
  const normalized = value.trim().replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
}

export function SummaryAnalysisSettingsForm({
  dispatchUnitCostCents
}: {
  dispatchUnitCostCents: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState(() => centsToInput(dispatchUnitCostCents));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const parsedCents = inputToCents(value);

  async function save() {
    if (parsedCents == null) {
      setMessage("Informe um custo valido.");
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/configuracoes/resumo-analise", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ dispatchUnitCostCents: parsedCents })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setMessage(payload?.error?.message ?? "Nao foi possivel salvar o custo por disparo.");
        return;
      }

      setValue(centsToInput(Number(payload.data?.dispatchUnitCostCents ?? parsedCents)));
      setMessage(payload?.message ?? "Custo por disparo atualizado.");
      router.refresh();
    } catch {
      setMessage("Falha de comunicacao ao salvar a configuracao.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="resumo-analise" className="rounded-2xl border border-default bg-surface-primary p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">Resumo e Análise</p>
          <h2 className="mt-1 text-xl font-semibold text-primary">Custos da ação</h2>
          <p className="mt-1 max-w-2xl text-sm text-secondary">
            Defina o custo unitário usado no cálculo automático das ações de Clínico e Orto.
          </p>
        </div>
        <span className="rounded-full border border-success bg-success-soft px-3 py-1 text-xs font-semibold text-success">
          Configuração de negócio
        </span>
      </div>

      <div className="mt-5 max-w-2xl">
        <label className="text-sm font-medium text-primary" htmlFor="dispatch-unit-cost">
          Custo unitário por disparo
        </label>
        <div className="mt-2 flex items-center rounded-xl border border-default bg-surface-secondary focus-within:border-focus focus-within:ring-2 focus-within:ring-brand">
          <span className="pl-4 text-sm font-semibold text-secondary">R$</span>
          <input
            id="dispatch-unit-cost"
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="min-w-0 flex-1 bg-transparent px-2 py-3 text-lg font-semibold text-primary outline-none"
            aria-describedby="dispatch-cost-help"
          />
        </div>
        <p id="dispatch-cost-help" className="mt-2 text-sm text-secondary">
          Este valor é aplicado automaticamente à quantidade de disparos informada no Resumo e Análise.
        </p>

        <div className="mt-4 rounded-xl border border-success bg-success-soft p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-success">Fórmula de cálculo</p>
          <p className="mt-1 text-sm font-semibold text-primary">
            Custo ação = Qtde disparos × Custo por disparo
          </p>
          <p className="mt-1 text-xs text-secondary">
            Valor atual: {formatCurrencyBR(parsedCents ?? dispatchUnitCostCents)} por disparo.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={busy || parsedCents == null}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Salvando..." : "Salvar"}
          </button>
          {message ? <p className="text-sm text-secondary">{message}</p> : null}
        </div>
      </div>
    </section>
  );
}
