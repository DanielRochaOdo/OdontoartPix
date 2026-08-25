"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { emitMetricsSync } from "@/lib/metrics-sync";

export function MemberActions({
  memberId,
  canDeleteMissingInstallment = false
}: {
  memberId: string;
  canDeleteMissingInstallment?: boolean;
}) {
  const router = useRouter();
  const [busyAction, setBusyAction] = useState<"reprocess" | "delete" | null>(null);
  const busy = busyAction !== null;

  async function reprocess() {
    setBusyAction("reprocess");
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
      setBusyAction(null);
    }
  }

  async function deleteMissingInstallment() {
    const confirmed = window.confirm(
      "Excluir este registro com parcela não encontrada? O cadastro global do associado será preservado."
    );
    if (!confirmed) return;

    setBusyAction("delete");
    try {
      const response = await fetch(`/api/associados/${memberId}`, {
        method: "DELETE"
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string }; message?: string }
        | null;

      if (!response.ok) {
        window.alert(payload?.error?.message ?? payload?.message ?? "Nao foi possivel excluir o registro.");
        return;
      }

      emitMetricsSync();
      router.refresh();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Falha de comunicacao ao excluir o registro.";
      window.alert(message);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={reprocess}
        disabled={busy}
        aria-label={busyAction === "reprocess" ? "Reprocessando associado" : "Reprocessar associado"}
        title={busyAction === "reprocess" ? "Reprocessando..." : "Reprocessar associado"}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-4 w-4 ${busyAction === "reprocess" ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 11a8.1 8.1 0 0 0-14.8-4L3 10" />
          <path d="M3 4v6h6" />
          <path d="M4 13a8.1 8.1 0 0 0 14.8 4L21 14" />
          <path d="M21 20v-6h-6" />
        </svg>
      </button>

      {canDeleteMissingInstallment ? (
        <button
          type="button"
          onClick={deleteMissingInstallment}
          disabled={busy}
          aria-label={busyAction === "delete" ? "Excluindo registro" : "Excluir registro com parcela não encontrada"}
          title={busyAction === "delete" ? "Excluindo..." : "Excluir registro com parcela não encontrada"}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-rose-200 text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M10 11v5" />
            <path d="M14 11v5" />
          </svg>
        </button>
      ) : null}
    </>
  );
}
