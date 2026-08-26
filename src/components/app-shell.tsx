"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Role } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { listenMetricsSync } from "@/lib/metrics-sync";
import { GlobalProcessingIndicator } from "@/components/global-processing-indicator";

function LogoIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="M7.3 5.5c1.8-1.7 3.8-1.4 4.7-.5.9-.9 2.9-1.2 4.7.5 1.8 1.7 1.2 4.7.3 6.6-.8 1.7-1.2 4.4-2.8 4.4-1.4 0-1.3-2.6-2.2-2.6s-1 2.6-2.2 2.6c-1.6 0-2-2.7-2.8-4.4-.9-1.9-1.5-4.9.3-6.6Z" className="stroke-[#00E5C3]" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 5.1c-.5 1.3-.5 2.8 0 4.2.5-1.4.5-2.9 0-4.2Z" className="stroke-[#00E5C3]" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function DashboardIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-11h6V4h-6v5Z" className="fill-current" />
    </svg>
  );
}

function CampaignsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="M5 6.5h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7l-4 3v-3.1a2 2 0 0 1-1-1.9v-7a2 2 0 0 1 2-2Z" className="stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 10h7M8 13h5" className="stroke-current" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function MembersIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" className="stroke-current" strokeWidth="1.8" />
      <path d="M5 19.5c1.4-2.8 3.8-4.2 7-4.2s5.6 1.4 7 4.2" className="stroke-current" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function LayersIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="m12 4 8 4-8 4-8-4 8-4Z" className="stroke-current" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="m4 12 8 4 8-4M4 16l8 4 8-4" className="stroke-current" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="M12 8.8A3.2 3.2 0 1 0 12 15.2 3.2 3.2 0 0 0 12 8.8Z" className="stroke-current" strokeWidth="1.8" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a6.8 6.8 0 0 0-2-.9L14 3h-4l-.5 2.9a6.8 6.8 0 0 0-2 .9l-2.4-1-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.4-1a6.8 6.8 0 0 0 2 .9L10 21h4l.5-2.9a6.8 6.8 0 0 0 2-.9l2.4 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2Z" className="stroke-current" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
  { href: "/campanhas", label: "Campanhas", icon: CampaignsIcon },
  { href: "/associados", label: "Associados", icon: MembersIcon },
  { href: "/configuracoes", label: "Configurações", icon: SettingsIcon }
];

export function AppShell({
  children,
  profile
}: {
  children: React.ReactNode;
  profile: { nome: string | null; email: string | null; role: Role | null };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [collapsed, setCollapsed] = useState(true);
  const focusMode = pathname.startsWith("/dashboard") && searchParams.get("focus") === "1";
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    return listenMetricsSync(() => {
      const now = Date.now();
      if (now - lastRefreshRef.current < 1500) return;
      lastRefreshRef.current = now;
      router.refresh();
    });
  }, [router]);

  return (
    <div className="min-h-screen w-full bg-app text-primary">
      <GlobalProcessingIndicator />

      {!focusMode ? (
        <aside
          className={`border-r border-[#1a6258] bg-[radial-gradient(circle_at_top,#0c332f_0%,#06201f_42%,#041817_100%)] text-white shadow-[8px_0_40px_rgba(0,0,0,0.18)] transition-[width] duration-200 lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:h-screen ${
            collapsed ? "lg:w-[92px]" : "lg:w-[264px]"
          }`}
        >
          <div className={`flex h-full max-h-screen flex-col overflow-hidden py-3 ${collapsed ? "px-2" : "px-4"}`}>
            <div className="shrink-0">
              <div className={`flex items-center ${collapsed ? "justify-center" : "gap-4 px-3"}`}>
                <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[#35d9bc]/70 bg-[#062b29] shadow-[0_0_0_5px_rgba(38,205,174,0.08),0_0_24px_rgba(38,205,174,0.24)]">
                  <LogoIcon className="h-8 w-8" />
                </div>
                {!collapsed ? (
                  <div className="min-w-0">
                    <div className="text-xs uppercase tracking-[0.3em] text-[#67e4c8]">OdontoartPix</div>
                    <h1 className="mt-1 text-base font-medium leading-tight tracking-[0.08em] text-[#52cdb4]">Análise de mensalidades</h1>
                  </div>
                ) : null}
              </div>

              <div className={`mt-3 ${collapsed ? "flex justify-center" : "px-2"}`}>
                <button
                  type="button"
                  onClick={() => setCollapsed((value) => !value)}
                  aria-label={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
                  title={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[#1b685d] bg-[#082624]/70 text-[#a5d8d0] transition hover:border-[#37d7bc] hover:bg-[#0b3934] hover:text-white"
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                    {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
                  </svg>
                </button>
              </div>

              {!collapsed ? (
                <div className="mt-3 flex items-center gap-3 rounded-2xl border border-[#1b6259] bg-[#0a2d2a]/80 px-3 py-3 shadow-[inset_0_1px_0_rgba(117,255,222,0.04)]">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#0b3732] text-[#53dbc0]">
                    <LayersIcon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-[#7cc6b8]">Ambiente operacional</p>
                    <p className="mt-1 truncate text-sm font-semibold text-[#f2fffc]">{profile.email ?? profile.nome ?? "Usuário autenticado"}</p>
                  </div>
                  <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-[#b8ddd7]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="m7 9 5 5 5-5" />
                  </svg>
                </div>
              ) : null}
            </div>

            <nav className={`mt-5 flex-1 overflow-y-auto pr-1 ${collapsed ? "space-y-4" : "space-y-2"}`}>
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={item.label}
                    className={`group relative flex rounded-2xl border transition duration-300 ${
                      collapsed ? "mx-auto h-14 w-14 items-center justify-center" : "items-center gap-3 px-3 py-2.5"
                    } ${
                      isActive
                        ? "border-[#2fe0c0] bg-[linear-gradient(135deg,rgba(28,128,111,0.62),rgba(11,67,61,0.82))] text-[#effffb] shadow-[0_0_20px_rgba(34,221,188,0.18),inset_0_1px_0_rgba(172,255,235,0.12)]"
                        : "border-transparent text-[#c2ddd8] hover:border-[#1d6259] hover:bg-[#0a302d]/80 hover:text-white"
                    }`}
                  >
                    <span
                      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border transition ${
                        isActive
                          ? "border-[#00E5C3]/50 bg-[#0b4b43] text-[#00E5C3]"
                          : "border-[#164b46] bg-[#092522]/65 text-[#bed6d1] group-hover:border-[#00B8FF] group-hover:text-[#00E5C3]"
                      }`}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    {!collapsed ? <span className="truncate text-sm tracking-wide">{item.label}</span> : null}
                  </Link>
                );
              })}
            </nav>

            <div className={`mt-4 shrink-0 border-t border-[#1b5b53] pt-3 ${collapsed ? "flex flex-col items-center gap-3" : "space-y-3 px-1"}`}>
              <div className={collapsed ? "contents" : "flex items-center gap-3"}>
                <ThemeToggle />
                {!collapsed ? <span className="text-sm text-[#c2ddd8]">Modo escuro</span> : null}
              </div>
              <div className={collapsed ? "contents" : "flex items-center gap-3"}>
                <LogoutButton />
                {!collapsed ? <span className="text-sm text-[#c2ddd8]">Sair da aplicação</span> : null}
              </div>
            </div>
          </div>
        </aside>
      ) : null}

      <main
        className={`min-w-0 transition-[margin-left] duration-200 ${
          focusMode ? "" : collapsed ? "lg:ml-[92px]" : "lg:ml-[264px]"
        }`}
      >
        {children}
      </main>
    </div>
  );
}
