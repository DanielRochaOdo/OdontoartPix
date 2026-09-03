"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CampaignControlIcon } from "@/components/campaign-control-icon";

type ImportResponse = {
  success?: boolean;
  data?: {
    campaignId?: string;
    summary?: {
      imported_records?: number;
      invalid_records?: number;
      skipped_duplicate_records?: number;
    };
  };
  error?: { message?: string };
  message?: string;
};

type CampaignOption = { id: string; name: string };
type BatchOption = { id: string; campaignId: string; name: string };

const STORAGE_KEY = "campaign-import-report";
const inputClass = "w-full rounded-lg border border-[#d6e3ef] bg-[#eef4f8] px-3 py-2 text-sm text-[#102033] dark:border-[#284665] dark:bg-[#0B2133] dark:text-[#F5F8FF]";

export function CampaignImportForm({
  campaigns,
  batches = [],
  initialCampaignId = "",
  initialCampaignName = ""
}: {
  campaigns: CampaignOption[];
  batches?: BatchOption[];
  initialCampaignId?: string;
  initialCampaignName?: string;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [campaignId, setCampaignId] = useState(initialCampaignId);
  const [campaignName, setCampaignName] = useState(initialCampaignName);
  const [batchId, setBatchId] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const availableBatches = useMemo(
    () => batches.filter((batch) => batch.campaignId === campaignId),
    [batches, campaignId]
  );
  const selectedBatchName = availableBatches.find((batch) => batch.id === batchId)?.name ?? "";

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
    setBusy(true);
    setStatus("");

    try {
      const response = await fetch("/api/campanhas/importar-v2", {
        method: "POST",
        body: new FormData(form),
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
      setStatus(`Base importada: ${imported} registro(s).${invalid ? ` ${invalid} ignorado(s).` : ""}${skipped ? ` ${skipped} parcela(s) ja existiam neste lote.` : ""}`);

      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          campaignId: json.data?.campaignId,
          message: json.message,
          summary: json.data?.summary
        }));
        window.dispatchEvent(new Event("campaign-import-report-updated"));
      } catch {}

      form.reset();
      setSelectedFile("");
      setBatchId("");
      router.replace("/campanhas");
      router.refresh();
    } catch {
      setStatus("Falha de comunicacao durante a importacao.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-[#16C79A]/70 bg-white p-5 shadow-sm dark:bg-[#071b34]/90">
      <div className="border-b border-[#183956] pb-4">
        <div className="flex items-center gap-3">
          <CampaignControlIcon name="importCampaign" className="h-7 w-7" />
          <div>
            <h2 className="text-lg font-semibold text-[#102033] dark:text-[#F5F8FF]">Importar campanha ou lote</h2>
            <p className="mt-1 text-sm text-[#5d7184] dark:text-[#8CA3B3]">Escolha uma campanha e importe para um lote existente ou crie um novo lote.</p>
          </div>
        </div>
      </div>

      {initialCampaignId ? (
        <>
          <input type="hidden" name="campaignId" value={initialCampaignId} />
          <input type="hidden" name="name" value={initialCampaignName} />
          <p className="text-sm text-slate-600 dark:text-slate-300">Campanha: <strong>{initialCampaignName}</strong></p>
        </>
      ) : (
        <>
          <label htmlFor="campaign-target" className="text-sm font-medium text-[#00F0C2]">Destino da importacao</label>
          <select
            id="campaign-target"
            name="campaignId"
            value={campaignId}
            onChange={(event) => {
              const nextId = event.target.value;
              setCampaignId(nextId);
              setCampaignName(campaigns.find((campaign) => campaign.id === nextId)?.name ?? "");
              setBatchId("");
            }}
            className={inputClass}
          >
            <option value="">Criar nova campanha</option>
            {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
          {campaignId ? <input type="hidden" name="name" value={campaignName} /> : (
            <input name="name" placeholder="Nome da campanha" required className={inputClass} />
          )}
        </>
      )}

      {campaignId ? (
        <>
          <label htmlFor="batch-target" className="text-sm font-medium text-[#00F0C2]">Lote de destino</label>
          <select id="batch-target" name="batchId" value={batchId} onChange={(event) => setBatchId(event.target.value)} className={inputClass}>
            <option value="">Criar novo lote</option>
            {availableBatches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}</option>)}
          </select>
          {batchId ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">Importando para o lote existente <strong>{selectedBatchName}</strong>. Parcelas ja presentes nele serao ignoradas.</p>
          ) : null}
        </>
      ) : null}

      {!batchId ? <input name="batchName" placeholder="Nome do novo lote" className={inputClass} /> : null}
      <textarea name="description" placeholder="Descricao" className={`${inputClass} min-h-20 resize-y`} />

      <div
        onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => { event.preventDefault(); setIsDragging(false); setFile(event.dataTransfer.files[0]); }}
        className={`rounded-xl border-2 border-dashed p-5 text-center ${isDragging ? "border-[#00F0C2] bg-[#0B3442]" : "border-[#284665] bg-[#071525]"}`}
      >
        <input ref={fileInputRef} id="campaign-file" name="file" type="file" accept=".csv,.txt,.xlsx,.xls" required onChange={(event) => setSelectedFile(event.target.files?.[0]?.name ?? "")} className="sr-only" />
        <label htmlFor="campaign-file" className="cursor-pointer text-sm text-[#AFC3D4]"><span className="font-medium text-[#00F0C2]">Arraste o arquivo aqui</span> ou clique para escolher</label>
        {selectedFile ? <p className="mt-2 truncate text-sm font-medium text-white">{selectedFile}</p> : null}
      </div>

      <button disabled={busy} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#00F0C2] px-4 py-3 text-sm font-semibold text-[#06151F] disabled:opacity-60">
        <CampaignControlIcon name="importBase" className="h-5 w-5" />{busy ? "Importando..." : "Importar base"}
      </button>
      {status ? <p className="text-sm text-slate-600 dark:text-slate-300">{status}</p> : null}
    </form>
  );
}
