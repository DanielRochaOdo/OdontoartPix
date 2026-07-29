"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

function EyeIcon({ slashed = false }: { slashed?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.5" />
      {slashed ? <path d="M4 4l16 16" /> : null}
    </svg>
  );
}

export function CampaignFocusToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const focused = searchParams.get("focus") === "1";

  function toggleFocus() {
    const params = new URLSearchParams(searchParams.toString());
    if (focused) params.delete("focus");
    else params.set("focus", "1");

    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <button
      type="button"
      onClick={toggleFocus}
      aria-label={focused ? "Sair do modo foco" : "Ativar modo foco"}
      title={focused ? "Sair do modo foco" : "Ativar modo foco"}
      className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50"
    >
      <EyeIcon slashed={focused} />
    </button>
  );
}
