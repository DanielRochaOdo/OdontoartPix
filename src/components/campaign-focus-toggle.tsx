"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ManualDashboardIcon } from "@/components/manual-dashboard-icon";

function EyeIcon({ slashed = false }: { slashed?: boolean }) {
  return <ManualDashboardIcon name="eye" className={`h-5 w-5 ${slashed ? "opacity-65" : ""}`} />;
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
      className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[#284665] bg-[#071b34] text-[#edf6ff] shadow-sm transition hover:border-[#00E5C3] hover:bg-[#0b2540] hover:text-[#00E5C3]"
    >
      <EyeIcon slashed={focused} />
    </button>
  );
}
