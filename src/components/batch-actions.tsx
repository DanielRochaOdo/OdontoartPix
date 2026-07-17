"use client";

import { useState } from "react";

export function BatchActions({ batchId }: { batchId: string }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function run(action: string) {
    setBusy(action);
    try {
      await fetch(`/api/lotes/${batchId}/${action}`, { method: "POST" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button disabled={busy !== null} onClick={() => run("processar")} className="rounded-md border px-3 py-1.5 text-sm">
        Processar
      </button>
      <button disabled={busy !== null} onClick={() => run("pausar")} className="rounded-md border px-3 py-1.5 text-sm">
        Pausar
      </button>
      <button disabled={busy !== null} onClick={() => run("retomar")} className="rounded-md border px-3 py-1.5 text-sm">
        Retomar
      </button>
      <button disabled={busy !== null} onClick={() => run("reprocessar-erros")} className="rounded-md border px-3 py-1.5 text-sm">
        Reprocessar erros
      </button>
    </>
  );
}
