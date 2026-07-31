"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Role } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { listenMetricsSync } from "@/lib/metrics-sync";

function LogoIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        className="fill-emerald-300/20 stroke-emerald-300"
        strokeWidth="1.8"
      />
      <path
        d="M14.8 8.7c-.8-.7-1.9-1-3-1-1.7 0-2.9.8-2.9 2 0 1.3 1.3 1.7 2.9 2 1.8.3 3.7.8 3.7 2.9 0 1.9-1.7 3.1-4 3.3v1.2h-1.2v-1.2c-1.5-.1-2.9-.6-4-1.5l.9-1.7c1 .9 2.3 1.4 3.7 1.4 1.4 0 2.4-.5 2.4-1.4 0-1-.9-1.4-2.5-1.7-2-.4-4-.9-4-3.2 0-1.8 1.5-1.3 3.8-3.3V5h1.2v1.2c1.3.1 2.4.5 3.3 1.2l-.8 1.5Z"
        className="fill-emerald-200"
      />
    </svg>
  );
}

function DashboardIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-11h6V4h-6v5Z"
        className="fill-current"
      />
    </svg>
  );
}

function CampaignsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-9Z"
        className="stroke-current"
        strokeWidth="1.8"
      />
      <path
        d="M7 9h10M7 12h10M7 15h6"
        className="stroke-current"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MembersIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        className="stroke-current"
        strokeWidth="1.8"
      />
      <path
        d="M5 19.5c1.4-2.8 3.8-4.2 7-4.2s5.6 1.4 7 4.2"
        className="stroke-current"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EventsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M6 5.5h12A1.5 1.5 0 0 1 19.5 7v10a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 17V7A1.5 1.5 0 0 1 6 5.5Z"
        className="stroke-current"
        strokeWidth="1.8"
      />
      <path
        d="M8 9h8M8 12h8M8 15h5"
        className="stroke-current"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SettingsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M12 8.8A3.2 3.2 0 1 0 12 15.2 3.2 3.2 0 0 0 12 8.8Z"
        className="stroke-current"
        strokeWidth="1.8"
      />
      <path
        d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a6.8 6.8 0 0 0-2-.9L14 3h-4l-.5 2.9a6.8 6.8 0 0 0-2 .9l-2.4-1-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.4-1a6.8 6.8 0 0 0 2 .9L10 21h4l.5-2.9a6.8 6.8 0 0 0 2-.9l2.4 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2Z"
        className="stroke-current"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
  { href: "/campanhas", label: "Campanhas", icon: CampaignsIcon },
  { href: "/associados", label: "Associados", icon: MembersIcon },
  { href: "/eventos", label: "Eventos", icon: EventsIcon },
  { href: "/configuracoes", label: "Configuracoes", icon: SettingsIcon }
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
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <div
        className={`mx-auto grid min-h-screen max-w-[1600px] grid-cols-1 transition-[grid-template-columns] duration-200 ${
          focusMode ? "lg:grid-cols-[1fr]" : collapsed ? "lg:grid-cols-[92px_1fr]" : "lg:grid-cols-[264px_1fr]"
        }`}
      >
        {!focusMode ? (
          <aside className="border-r border-emerald-900/70 bg-emerald-950 text-white lg:sticky lg:top-0 lg:h-screen">
            <div className="flex h-full max-h-screen flex-col overflow-hidden px-3 py-5">
              <div className="shrink-0">
                <div className={`flex items-center ${collapsed ? "justify-center" : "gap-3 px-2"}`}>
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-900 ring-1 ring-emerald-700/80">
                    <LogoIcon className="h-7 w-7" />
                  </div>
                  {!collapsed ? (
                    <div className="min-w-0">
                      <div className="text-xs uppercase tracking-[0.35em] text-emerald-300">
                        OdontoartPix
                      </div>
                      <h1 className="mt-1 text-base font-semibold leading-tight text-white">
                        Analise de mensalidades
                      </h1>
                    </div>
                  ) : null}
                </div>

                <div className={`mt-4 ${collapsed ? "flex justify-center" : "px-2"}`}>
                  <button
                    type="button"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-label={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
                    title={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-800 text-emerald-100 transition hover:bg-emerald-900 hover:text-white"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
                    </svg>
                  </button>
                </div>

                {!collapsed ? (
                  <div className="mt-4 rounded-2xl border border-emerald-900 bg-emerald-900/40 px-4 py-3">
                    <p className="text-xs text-emerald-200/80">Ambiente operacional</p>
                    <p className="mt-1 truncate text-sm font-semibold text-white">
                      {profile.nome ?? profile.email ?? "Usuario autenticado"}
                    </p>
                  </div>
                ) : null}
              </div>

              <nav className="mt-8 flex-1 space-y-2 overflow-y-auto pr-1">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.label}
                      className={`group flex rounded-2xl text-sm text-slate-100 transition hover:bg-white/10 hover:text-white ${
                        collapsed ? "justify-center px-0 py-3" : "items-center gap-3 px-4 py-3"
                      }`}
                    >
                      <span className="inline-flex h-6 w-6 items-center justify-center text-emerald-200">
                        <Icon />
                      </span>
                      {!collapsed ? <span className="truncate">{item.label}</span> : null}
                    </Link>
                  );
                })}
              </nav>

              <div
                className={`mt-6 shrink-0 border-t border-emerald-800/80 pt-4 ${
                  collapsed ? "flex flex-col items-center gap-2" : "flex items-center gap-2 px-2"
                }`}
              >
                <ThemeToggle />
                <LogoutButton />
              </div>
            </div>
          </aside>
        ) : null}

        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
