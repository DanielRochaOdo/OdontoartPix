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
      <path d="M7.3 5.5c1.8-1.7 3.8-1.4 4.7-.5.9-.9 2.9-1.2 4.7.5 1.8 1.7 1.2 4.7.3 6.6-.8 1.7-1.2 4.4-2.8 4.4-1.4 0-1.3-2.6-2.2-2.6s-1 2.6-2.2 2.6c-1.6 0-2-2.7-2.8-4.4-.9-1.9-1.5-4.9.3-6.6Z" className="stroke-current" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 5.1c-.5 1.3-.5 2.8 0 4.2.5-1.4.5-2.9 0-4.2Z" className="stroke-current" strokeWidth="1.4" strokeLinecap="round" />
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

function DispatchIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="m3.5 11 16-7-5.8 16-2.7-6.9L3.5 11Z" className="stroke-current" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="m11 13 8.5-9" className="stroke-current" strokeWidth="1.8" strokeLinecap="round" />
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

function AnalysisIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="M5 19V9M12 19V5M19 19v-7" className="stroke-current" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3 19.5h18" className="stroke-current" strokeWidth="1.8" strokeLinecap="round" />
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
  { href: "/disparos", label: "Disparos", icon: DispatchIcon },
  { href: "/resumo-analise", label: "Resumo e Análise", icon: AnalysisIcon },
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
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const focusMode = pathname.startsWith("/dashboard") && searchParams.get("focus") === "1";
  const lastRefreshRef = useRef(0);
  const activePage = navItems.find((item) =>
    pathname === item.href || pathname.startsWith(`${item.href}/`)
  );
  const pageLabel = activePage?.label ?? "ODONTOPIX";

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
        <>
          <div
            className={`fixed inset-0 z-40 bg-[#101d33]/55 transition-opacity lg:hidden ${mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
            aria-hidden="true"
            onClick={() => setMobileOpen(false)}
          />
          <aside
            id="odontopix-sidebar"
            aria-label="Menu principal"
            className={`odontopix-sidebar fixed inset-y-0 left-0 z-50 flex w-[246px] flex-col bg-[#101d33] text-[#bac7d8] shadow-[8px_0_30px_rgba(16,29,51,0.08)] transition-[transform,width] duration-200 ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"} ${collapsed ? "lg:w-[78px]" : "lg:w-[246px]"}`}
          >
            <div className={`flex min-h-0 flex-1 flex-col px-3 pb-4 pt-6 ${collapsed ? "lg:px-2" : ""}`}>
              <div className={`flex shrink-0 items-center gap-3 px-2 ${collapsed ? "lg:justify-center lg:px-0" : ""}`}>
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#28d3bb] to-[#0796ac] text-white shadow-[0_7px_20px_rgba(21,187,175,0.18)]">
                  <LogoIcon className="h-7 w-7" />
                </span>
                <div className={`min-w-0 ${collapsed ? "lg:hidden" : ""}`}>
                  <p className="text-[18px] font-extrabold leading-tight tracking-[-0.05em] text-white">ODONTOPIX</p>
                  <p className="mt-0.5 text-[9px] font-semibold tracking-[0.18em] text-[#8ca0b9]">GESTÃO FINANCEIRA</p>
                </div>
                <button
                  type="button"
                  className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-lg text-[#bbcadb] hover:bg-[#213451] hover:text-white lg:hidden"
                  aria-label="Fechar menu"
                  onClick={() => setMobileOpen(false)}
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18"/></svg>
                </button>
              </div>

              <div className={`mt-8 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[#71859e] ${collapsed ? "lg:sr-only" : ""}`}>Navegação</div>
              <nav aria-label="Navegação principal" className="mt-3 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.label}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => setMobileOpen(false)}
                      className={`group relative flex min-h-11 items-center gap-3 rounded-[10px] px-3 py-2.5 text-[13px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#75cec4] ${collapsed ? "lg:justify-center lg:px-2" : ""} ${isActive ? "bg-[#183f49] text-[#a5fff1] shadow-[inset_3px_0_#1dc7b3]" : "text-[#bac7d8] hover:bg-[#213451] hover:text-white"}`}
                    >
                      <Icon className={`h-[19px] w-[19px] shrink-0 ${isActive ? "text-[#23d6bd]" : ""}`} />
                      <span className={collapsed ? "lg:sr-only" : ""}>{item.label}</span>
                    </Link>
                  );
                })}
              </nav>

              <div className={`mt-4 shrink-0 border-t border-[#2a3b52] pt-4 ${collapsed ? "lg:flex lg:flex-col lg:items-center" : ""}`}>
                <div className={`flex items-center gap-3 px-2 ${collapsed ? "lg:px-0" : ""}`}>
                  <ThemeToggle />
                  <span className={`text-xs text-[#bac7d8] ${collapsed ? "lg:sr-only" : ""}`}>Alternar tema</span>
                </div>
                <div className={`mt-2 flex items-center gap-3 px-2 ${collapsed ? "lg:px-0" : ""}`}>
                  <LogoutButton />
                  <span className={`text-xs text-[#bac7d8] ${collapsed ? "lg:sr-only" : ""}`}>Sair da aplicação</span>
                </div>
                <p className={`mt-3 truncate px-2 text-[11px] text-[#8fa2b7] ${collapsed ? "lg:sr-only" : ""}`} title={profile.email ?? profile.nome ?? undefined}>
                  {profile.nome ?? profile.email ?? "Usuário autenticado"}
                </p>
              </div>
            </div>
          </aside>

          <header className={`sticky top-0 z-30 flex h-[64px] items-center justify-between gap-4 border-b border-subtle bg-surface-primary px-4 sm:px-6 lg:h-[73px] lg:px-9 ${collapsed ? "lg:ml-[78px]" : "lg:ml-[246px]"}`}>
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                aria-label="Abrir menu"
                aria-controls="odontopix-sidebar"
                aria-expanded={mobileOpen}
                onClick={() => setMobileOpen(true)}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-default text-secondary hover:bg-surface-hover lg:hidden"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
              </button>
              <button
                type="button"
                aria-label={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
                title={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
                onClick={() => setCollapsed((value) => !value)}
                className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-default text-secondary hover:bg-surface-hover lg:inline-flex"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d={collapsed ? "m9 6 6 6-6 6" : "m15 6-6 6 6 6"}/></svg>
              </button>
              <div className="min-w-0 truncate text-xs text-secondary">
                <span className="hidden sm:inline">ODONTOPIX <span className="mx-2 text-muted">/</span> </span>
                <strong className="font-semibold text-primary">{pageLabel}</strong>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden rounded-full border border-[#bce5e0] bg-[#effbf8] px-3 py-2 text-[11px] font-bold text-[#087e75] dark:border-[#235851] dark:bg-[#153b37] dark:text-[#a5fff1] sm:inline-flex">Ambiente operacional</span>
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#eaf1f9] text-xs font-extrabold text-[#455a75] dark:bg-[#1d3550] dark:text-[#dbedf8]" aria-label="Usuário autenticado">
                {(profile.nome?.trim() || profile.email?.trim() || "O").charAt(0).toUpperCase()}
              </span>
            </div>
          </header>
        </>
      ) : null}

      <div className={`min-w-0 transition-[margin-left] duration-200 ${focusMode ? "" : collapsed ? "lg:ml-[78px]" : "lg:ml-[246px]"}`}>
        {children}
      </div>
    </div>
  );
}
