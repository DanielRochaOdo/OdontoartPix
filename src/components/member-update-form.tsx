"use client";

import { type DragEvent, useRef, useState } from "react";

type UpdateResponse = {
  success?: boolean;
  data?: {
    summary?: {
      updated_records?: number;
      invalid_records?: number;
    };
  };
  error?: { message?: string };
};

export function MemberUpdateForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = selectedFile;
    if (!file) {
      setStatus("Selecione um arquivo para atualizar os associados.");
      return;
    }

    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/associados/atualizar", {
        method: "POST",
        body: (() => {
          const formData = new FormData();
          formData.append("file", file);
          return formData;
        })(),
        headers: { Accept: "application/json" }
      });
      const payload = (await response.json().catch(() => null)) as UpdateResponse | null;
      if (!response.ok || !payload?.success) {
        setStatus(payload?.error?.message ?? "Nao foi possivel atualizar os associados.");
        return;
      }

      const summary = payload.data?.summary;
      setStatus(
        `${summary?.updated_records ?? 0} registro(s) atualizado(s).` +
          (summary?.invalid_records ? ` ${summary.invalid_records} registro(s) com pendencia.` : "")
      );
      form.reset();
      setSelectedFile(null);
    } catch {
      setStatus("Falha de comunicacao durante a atualizacao.");
    } finally {
      setBusy(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) setSelectedFile(file);
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-amber-950 dark:text-amber-100">Atualizar dados dos associados</h2>
          <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-200/80">
            CodigoAssociadoEmpresa e Parcela sao obrigatorios; preencha tambem as colunas que deseja alterar. A operacao nao consulta o ERP.
          </p>
        </div>
        <a href="/api/associados/modelo-atualizacao" className="text-sm font-medium text-amber-900 underline dark:text-amber-100">
          Baixar modelo
        </a>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={`flex min-w-[250px] items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-sm transition ${dragging ? "border-amber-700 bg-amber-100 dark:bg-amber-900/40" : "border-amber-300 bg-white/70 dark:border-amber-800 dark:bg-black/10"}`}
        >
          <input
            ref={inputRef}
            id="member-update-file"
            type="file"
            accept=".csv,.txt,.xlsx,.xls"
            required
            className="sr-only"
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
          />
          <label htmlFor="member-update-file" className="cursor-pointer rounded-md bg-amber-700 px-3 py-1.5 font-medium text-white hover:bg-amber-800">
            Escolher arquivo
          </label>
          <span className="truncate text-amber-950 dark:text-amber-100">
            {selectedFile?.name ?? "Arraste e solte o arquivo aqui"}
          </span>
        </div>
        <button type="submit" disabled={busy} className="rounded-lg bg-amber-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60">
          {busy ? "Atualizando..." : "Atualizar dados"}
        </button>
      </div>
      {status ? <p className="mt-3 text-sm text-amber-950 dark:text-amber-100">{status}</p> : null}
    </form>
  );
}
