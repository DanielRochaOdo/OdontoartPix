"use client";

import { useRef, useState } from "react";
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
      issues?: Array<{ line?: number; associatedCode?: string; targetInstallmentId?: string; reason?: string }>;
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
          window.dispatchEvent(new Event("campaign-import-report-updated"));
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
      className="space-y-4 rounded-2xl border border-[#16C79A]/70 bg-white p-5 shadow-sm dark:bg-[#071b34]/90 dark:shadow-[0_8px_28px_rgba(0,0,0,0.2)]"
    >
      <div className="border-b border-[#183956] pb-4">
        <div className="flex items-center gap-3"><span className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-[#d6e3ef] bg-[#eef4f8] dark:border-[#284665] dark:bg-[#071525]"><CampaignControlIcon name="importCampaign" className="h-7 w-7" /></span><div><h2 className="text-lg font-semibold text-[#102033] dark:text-[#F5F8FF]">Importar campanha ou lote</h2>
        <p className="mt-1 text-sm text-[#5d7184] dark:text-[#8CA3B3]">
          Aceita CSV, TXT e XLSX com CodigoAssociadoEmpresa, Parcela e Valor da Parcela obrigatorios.
        </p></div></div>
      </div>
      {initialCampaignId ? (
        <>
          <input type="hidden" name="campaignId" value={initialCampaignId} />
          <p className="text-sm text-slate-600 dark:text-slate-300">Novo lote para: <strong className="text-slate-900 dark:text-white">{initialCampaignName}</strong></p>
        </>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm font-medium text-[#00F0C2]" htmlFor="campaign-target"><CampaignControlIcon name="destination" className="h-5 w-5" />Destino da importacao</label>
          <select
            id="campaign-target"
            name="campaignId"
            value={campaignId}
            onChange={(event) => {
              const nextId = event.target.value;
              setCampaignId(nextId);
              setCampaignName(campaigns.find((campaign) => campaign.id === nextId)?.name ?? "");
            }}
            className="w-full rounded-lg border border-[#d6e3ef] bg-[#eef4f8] px-3 py-2 text-sm text-[#102033] dark:border-[#284665] dark:bg-[#0B2133] dark:text-[#F5F8FF]"
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
        <div className="flex items-center gap-3 rounded-lg border border-[#d6e3ef] bg-[#eef4f8] px-3 dark:border-[#284665] dark:bg-[#0B2133]"><CampaignControlIcon name="campaignName" className="h-5 w-5 shrink-0" /><input name="name" placeholder="Nome da campanha" required className="campaign-field-control w-full py-3 text-sm text-[#102033] outline-none placeholder:text-[#5d7184] dark:text-[#F5F8FF] dark:placeholder:text-[#8CA3B3]" /></div>
      )}
      <div className="flex items-center gap-3 rounded-lg border border-[#d6e3ef] bg-[#eef4f8] px-3 dark:border-[#284665] dark:bg-[#0B2133]"><CampaignControlIcon name="batchName" className="h-5 w-5 shrink-0" /><input name="batchName" placeholder="Nome do lote" className="campaign-field-control w-full py-3 text-sm text-[#102033] outline-none placeholder:text-[#5d7184] dark:text-[#F5F8FF] dark:placeholder:text-[#8CA3B3]" /></div>
      <div className="flex items-start gap-3 rounded-lg border border-[#d6e3ef] bg-[#eef4f8] px-3 dark:border-[#284665] dark:bg-[#0B2133]"><CampaignControlIcon name="description" className="mt-3 h-5 w-5 shrink-0" /><textarea name="description" placeholder="Descricao" className="campaign-field-control min-h-24 w-full resize-y py-3 text-sm text-[#102033] outline-none placeholder:text-[#5d7184] dark:text-[#F5F8FF] dark:placeholder:text-[#8CA3B3]" /></div>
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
            ? "border-[#00F0C2] bg-[#0B3442]"
            : "border-[#284665] bg-[#071525]"
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
        <label htmlFor="campaign-file" className="flex cursor-pointer flex-col items-center text-sm text-[#AFC3D4]">
          <CampaignControlIcon name="upload" className="h-12 w-12" /><span className="mt-2"><span className="font-medium text-[#00F0C2]">Arraste o arquivo aqui</span> ou clique para escolher</span>
        </label>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">CSV, TXT ou XLSX</p>
        {selectedFile ? <p className="mt-2 truncate text-sm font-medium text-slate-900 dark:text-white">{selectedFile}</p> : null}
      </div>
      <button
        disabled={busy}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#00F0C2] px-4 py-3 text-sm font-semibold text-[#06151F] shadow-[0_0_18px_rgba(0,240,194,0.2)] transition hover:bg-[#73FFE8] disabled:opacity-60"
      >
        <CampaignControlIcon name="importBase" className="h-5 w-5" />{busy ? "Importando..." : "Importar base"}
      </button>
      {status ? <p className="text-sm text-slate-600">{status}</p> : null}
    </form>
  );
}
