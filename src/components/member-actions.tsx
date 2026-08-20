"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { emitMetricsSync } from "@/lib/metrics-sync";

export function MemberActions({ memberId }: { memberId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function reprocess() {
    setBusy(true);
    try {
      const response = await fetch(`/api/associados/${memberId}/reprocessar`, {
        method: "POST"
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        const message = payload?.error?.message ?? "Nao foi possivel reprocessar o associado.";
        window.alert(message);
        return;
      }
      emitMetricsSync();
      router.refresh();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Falha de comunicacao ao reprocessar o associado.";
      window.alert(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={reprocess}
      disabled={busy}
      aria-label={busy ? "Reprocessando associado" : "Reprocessar associado"}
      title={busy ? "Reprocessando..." : "Reprocessar associado"}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 11a8.1 8.1 0 0 0-14.8-4L3 10" />
        <path d="M3 4v6h6" />
        <path d="M4 13a8.1 8.1 0 0 0 14.8 4L21 14" />
        <path d="M21 20v-6h-6" />
      </svg>
    </button>
  );
}
