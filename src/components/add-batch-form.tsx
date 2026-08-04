"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const STORAGE_KEY = "campaign-import-report";

export function AddBatchForm({ campaignId, campaignName, onCompleted }: { campaignId: string; campaignName: string; onCompleted?: () => void }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [batchName, setBatchName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
    if (!batchName.trim() || !fileInputRef.current?.files?.length || busy) return;

    setBusy(true);
    setMessage(null);
    const data = new FormData(form);
    data.set("campaignId", campaignId);
    data.set("name", campaignName);
    data.set("batchName", batchName.trim());

    try {
      const response = await fetch("/api/campanhas/importar", {
        method: "POST",
        body: data,
        headers: { Accept: "application/json" }
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setMessage(payload?.error?.message ?? "Nao foi possivel adicionar o lote.");
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
      setMessage(`Lote adicionado com sucesso.${skipped ? ` ${skipped} CPF(s) ja estavam em outro lote e foram ignorados.` : ""}`);
      form.reset();
      setBatchName("");
      setFileName("");
      onCompleted?.();
      router.refresh();
    } catch {
      setMessage("Falha de comunicacao ao adicionar o lote.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm dark:border-emerald-800 dark:bg-emerald-950/40">
      <h2 className="text-lg font-semibold">Adicionar lote</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Campanha: <strong className="text-slate-900 dark:text-white">{campaignName}</strong></p>
      <input name="batchName" value={batchName} onChange={(event) => setBatchName(event.target.value)} placeholder="Nome do lote" required className="mt-4 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
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
        className={`mt-3 rounded-xl border-2 border-dashed p-4 text-center transition ${isDragging ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950" : "border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800"}`}
      >
        <input ref={fileInputRef} id="batch-file" name="file" type="file" accept=".csv,.txt,.xlsx,.xls" required onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")} className="sr-only" />
        <label htmlFor="batch-file" className="cursor-pointer text-sm text-slate-600 dark:text-slate-300">
          <span className="font-medium text-emerald-700 dark:text-emerald-300">Arraste o arquivo aqui</span> ou clique para escolher
        </label>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">CSV, TXT ou XLSX</p>
        {fileName ? <p className="mt-1 truncate text-xs font-medium text-slate-900 dark:text-white">{fileName}</p> : null}
      </div>
      <button type="submit" disabled={busy || !batchName.trim() || !fileName} className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60">
        {busy ? "Importando..." : "Adicionar lote"}
      </button>
      {message ? <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{message}</p> : null}
    </form>
  );
}
