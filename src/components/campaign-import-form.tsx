"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ImportResponse = {
  success?: boolean;
  data?: {
    campaignId?: string;
    summary?: {
      imported_records?: number;
      invalid_records?: number;
      skipped_duplicate_records?: number;
      issues?: Array<{ line?: number; associatedCode?: string; reason?: string }>;
    };
  };
  error?: { message?: string };
  message?: string;
};

const STORAGE_KEY = "campaign-import-report";

export function CampaignImportForm({
  campaigns,
  initialCampaignId = "",
  initialCampaignName = ""
}: {
  campaigns: Array<{ id: string; name: string }>;
  initialCampaignId?: string;
  initialCampaignName?: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [campaignId, setCampaignId] = useState(initialCampaignId);
  const [campaignName, setCampaignName] = useState(initialCampaignName);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function setFile(file: File | undefined) {
    if (!file || !fileInputRef.current) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInputRef.current.files = transfer.files;
    setSelectedFile(file.name);
  }

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
        setStatus(json?.error?.message ?? "Falha na importacao.");
        return;
      }

      const imported = json.data?.summary?.imported_records ?? 0;
      const invalid = json.data?.summary?.invalid_records ?? 0;
      const skipped = json.data?.summary?.skipped_duplicate_records ?? 0;

      setStatus(
        `Base importada: ${imported} registros aguardando processamento.${invalid ? ` ${invalid} registro(s) foram ignorados.` : ""}${skipped ? ` ${skipped} parcela(s) foram ignoradas por ja estarem vinculadas a outra campanha.` : ""}`
      );
      form.reset();

      if (json.data?.campaignId) {
        try {
          window.sessionStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              campaignId: json.data.campaignId,
              message: json.message,
              summary: json.data.summary
            })
          );
        } catch {}
        router.push(`/campanhas/${json.data.campaignId}`);
        router.refresh();
      }
    } catch {
      setStatus("Falha de comunicacao durante a importacao.");
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
        <h2 className="text-lg font-semibold">Importar campanha ou lote</h2>
        <p className="mt-1 text-sm text-slate-500">
          Aceita CSV, TXT e XLSX com CodigoAssociadoEmpresa, Parcela e Valor da Parcela obrigatorios.
        </p>
      </div>
      {initialCampaignId ? (
        <>
          <input type="hidden" name="campaignId" value={initialCampaignId} />
          <p className="text-sm text-slate-600 dark:text-slate-300">Novo lote para: <strong className="text-slate-900 dark:text-white">{initialCampaignName}</strong></p>
        </>
      ) : (
        <>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200" htmlFor="campaign-target">Destino da importacao</label>
          <select
            id="campaign-target"
            name="campaignId"
            value={campaignId}
            onChange={(event) => {
              const nextId = event.target.value;
              setCampaignId(nextId);
              setCampaignName(campaigns.find((campaign) => campaign.id === nextId)?.name ?? "");
            }}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="">Criar nova campanha</option>
            {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>Adicionar lote em: {campaign.name}</option>)}
          </select>
        </>
      )}
      {initialCampaignId ? (
        <input type="hidden" name="name" value={initialCampaignName} />
      ) : campaignId ? (
        <>
          <p className="text-xs text-slate-500 dark:text-slate-400">A planilha sera adicionada como um novo lote em <strong className="text-slate-700 dark:text-slate-200">{campaignName}</strong>.</p>
          <input type="hidden" name="name" value={campaignName} />
        </>
      ) : (
        <input
          name="name"
          placeholder="Nome da campanha"
          required
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
      )}
      <input
        name="batchName"
        placeholder="Nome do lote"
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      />
      <textarea
        name="description"
        placeholder="Descricao"
        className="min-h-24 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      />
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          setFile(event.dataTransfer.files[0]);
        }}
        className={`rounded-xl border-2 border-dashed p-5 text-center transition ${
          isDragging
            ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950"
            : "border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-800"
        }`}
      >
        <input
          ref={fileInputRef}
          id="campaign-file"
          name="file"
          type="file"
          accept=".csv,.txt,.xlsx,.xls"
          required
          onChange={(event) => setSelectedFile(event.target.files?.[0]?.name ?? "")}
          className="sr-only"
        />
        <label htmlFor="campaign-file" className="cursor-pointer text-sm text-slate-600 dark:text-slate-300">
          <span className="font-medium text-emerald-700 dark:text-emerald-300">Arraste o arquivo aqui</span> ou clique para escolher
        </label>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">CSV, TXT ou XLSX</p>
        {selectedFile ? <p className="mt-2 truncate text-sm font-medium text-slate-900 dark:text-white">{selectedFile}</p> : null}
      </div>
      <button
        disabled={busy}
        className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60"
      >
        {busy ? "Importando..." : "Importar base"}
      </button>
      {status ? <p className="text-sm text-slate-600">{status}</p> : null}
    </form>
  );
}
