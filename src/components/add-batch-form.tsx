"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const STORAGE_KEY = "campaign-import-report";

export function AddBatchForm({
  campaignId,
  campaignName,
  batches = [],
  onCompleted
}: {
  campaignId: string;
  campaignName: string;
  batches?: Array<{ id: string; name: string }>;
  onCompleted?: () => void;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [batchId, setBatchId] = useState("");
  const [batchName, setBatchName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const creatingBatch = !batchId;
  const selectedBatchName = batches.find((batch) => batch.id === batchId)?.name ?? "";
  const canSubmit = Boolean(fileName) && Boolean(batchId || batchName.trim()) && !busy;

  function setFile(file: File | undefined) {
    if (!file || !fileInputRef.current) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInputRef.current.files = transfer.files;
    setFileName(file.name);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!canSubmit) return;

    setBusy(true);
    setMessage(null);
    const data = new FormData(form);
    data.set("campaignId", campaignId);
    data.set("name", campaignName);
    if (batchId) {
      data.set("batchId", batchId);
      data.delete("batchName");
    } else {
      data.delete("batchId");
      data.set("batchName", batchName.trim());
    }

    try {
      const response = await fetch("/api/campanhas/importar", {
        method: "POST",
        body: data,
        headers: { Accept: "application/json" }
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setMessage(payload?.error?.message ?? "Nao foi possivel importar a base.");
        return;
      }

      try {
        window.sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            campaignId: payload.data?.campaignId ?? campaignId,
            batchId: payload.data?.batchId,
            message: payload.message,
            summary: payload.data?.summary
          })
        );
        window.dispatchEvent(new Event("campaign-import-report-updated"));
      } catch {}

      const skipped = payload.data?.summary?.skipped_duplicate_records ?? 0;
      setMessage(
        `${creatingBatch ? "Lote adicionado" : `Base importada em ${selectedBatchName}`} com sucesso.${skipped ? ` ${skipped} parcela(s) ja existiam neste lote e foram ignoradas.` : ""}`
      );
      form.reset();
      setBatchId("");
      setBatchName("");
      setFileName("");
      onCompleted?.();
      router.refresh();
    } catch {
      setMessage("Falha de comunicacao ao importar a base.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm dark:border-emerald-800 dark:bg-emerald-950/40">
      <h2 className="text-lg font-semibold">Adicionar parcelas</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Campanha: <strong className="text-slate-900 dark:text-white">{campaignName}</strong></p>

      <label htmlFor="existing-batch" className="mt-4 block text-sm font-medium">Lote de destino</label>
      <select
        id="existing-batch"
        value={batchId}
        onChange={(event) => setBatchId(event.target.value)}
        className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
      >
        <option value="">Criar novo lote</option>
        {batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}</option>)}
      </select>

      {creatingBatch ? (
        <input name="batchName" value={batchName} onChange={(event) => setBatchName(event.target.value)} placeholder="Nome do novo lote" required className="mt-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
      ) : (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">As novas parcelas serao adicionadas ao lote existente. Parcelas ja presentes nele serao ignoradas.</p>
      )}

      <div
        onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => { event.preventDefault(); setIsDragging(false); setFile(event.dataTransfer.files[0]); }}
        className={`mt-3 rounded-xl border-2 border-dashed p-4 text-center transition ${isDragging ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950" : "border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800"}`}
      >
        <input ref={fileInputRef} id="batch-file" name="file" type="file" accept=".csv,.txt,.xlsx,.xls" required onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")} className="sr-only" />
        <label htmlFor="batch-file" className="cursor-pointer text-sm text-slate-600 dark:text-slate-300"><span className="font-medium text-emerald-700 dark:text-emerald-300">Arraste o arquivo aqui</span> ou clique para escolher</label>
        {fileName ? <p className="mt-1 truncate text-xs font-medium text-slate-900 dark:text-white">{fileName}</p> : null}
      </div>

      <button type="submit" disabled={!canSubmit} className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60">
        {busy ? "Importando..." : creatingBatch ? "Criar lote e importar" : "Importar para lote"}
      </button>
      {message ? <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{message}</p> : null}
    </form>
  );
}
