"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type ImportResponse = {
  success?: boolean;
  data?: {
    campaignId?: string;
    summary?: { imported_records?: number };
  };
  error?: { message?: string };
  message?: string;
};

export function CampaignImportForm() {
  const router = useRouter();
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setStatus("");

    try {
      const response = await fetch("/api/campanhas/importar", {
        method: "POST",
        body: data,
        headers: { Accept: "application/json" }
      });
      const json = (await response.json().catch(() => null)) as ImportResponse | null;

      if (!response.ok || !json?.success) {
        setStatus(json?.error?.message ?? "Falha na importação.");
        return;
      }

      const imported = json.data?.summary?.imported_records ?? 0;
      setStatus(`Base importada: ${imported} registros aguardando processamento.`);
      form.reset();

      if (json.data?.campaignId) {
        router.push(`/campanhas/${json.data.campaignId}`);
        router.refresh();
      }
    } catch {
      setStatus("Falha de comunicação durante a importação.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div>
        <h2 className="text-lg font-semibold">Importar campanha</h2>
        <p className="mt-1 text-sm text-slate-500">
          Aceita CSV, TXT e XLSX com CPF com ou sem pontuação. A consulta ao ERP é iniciada depois, pelo botão de processamento.
        </p>
      </div>
      <input
        name="name"
        placeholder="Nome da campanha"
        required
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      />
      <textarea
        name="description"
        placeholder="Descrição"
        className="min-h-24 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      />
      <input
        name="file"
        type="file"
        accept=".csv,.txt,.xlsx,.xls"
        required
        className="block w-full text-sm"
      />
      <button
        disabled={busy}
        className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {busy ? "Importando..." : "Importar base"}
      </button>
      {status ? <p className="text-sm text-slate-600">{status}</p> : null}
    </form>
  );
}
