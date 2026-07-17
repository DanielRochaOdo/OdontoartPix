"use client";

import { useState } from "react";

export function MemberActions({ memberId }: { memberId: string }) {
  const [busy, setBusy] = useState(false);

  async function reprocess() {
    setBusy(true);
    try {
      await fetch(`/api/associados/${memberId}/reprocessar`, { method: "POST" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button onClick={reprocess} disabled={busy} className="rounded-md border px-3 py-1.5 text-sm">
      {busy ? "Reprocessando..." : "Reprocessar"}
    </button>
  );
}
