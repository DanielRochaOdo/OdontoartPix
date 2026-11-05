"use client";

import { useState } from "react";
import { useAutomaticSyncLock, AUTOMATIC_SYNC_LOCK_TOOLTIP } from "@/components/automatic-sync-lock-provider";

export function BatchActions({ batchId }: { batchId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const { automaticSyncEnabled } = useAutomaticSyncLock();

  async function run(action: string) {
    if (automaticSyncEnabled && action !== "pausar") return;
    setBusy(action);
    try {
      await fetch(`/api/lotes/${batchId}/${action}`, { method: "POST" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button title={automaticSyncEnabled ? AUTOMATIC_SYNC_LOCK_TOOLTIP : undefined} disabled={busy !== null || automaticSyncEnabled} onClick={() => run("processar")} className="rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50">
        Processar
      </button>
      <button disabled={busy !== null} onClick={() => run("pausar")} className="rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50">
        Pausar
      </button>
      <button title={automaticSyncEnabled ? AUTOMATIC_SYNC_LOCK_TOOLTIP : undefined} disabled={busy !== null || automaticSyncEnabled} onClick={() => run("retomar")} className="rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50">
        Retomar
      </button>
      <button title={automaticSyncEnabled ? AUTOMATIC_SYNC_LOCK_TOOLTIP : undefined} disabled={busy !== null || automaticSyncEnabled} onClick={() => run("reprocessar-erros")} className="rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50">
        Reprocessar erros
      </button>
      <button title={automaticSyncEnabled ? AUTOMATIC_SYNC_LOCK_TOOLTIP : undefined} disabled={busy !== null || automaticSyncEnabled} onClick={() => run("reprocessar-bloqueados")} className="rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50">
        Reprocessar bloqueados
      </button>
    </>
  );
}
