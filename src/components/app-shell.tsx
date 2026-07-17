import Link from "next/link";
import type { Role } from "@/lib/auth";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/campanhas", label: "Campanhas" },
  { href: "/associados", label: "Associados" }
];

export function AppShell({
  children,
  profile
}: {
  children: React.ReactNode;
  profile: { nome: string | null; email: string | null; role: Role | null };
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <div className="mx-auto grid min-h-screen max-w-[1600px] grid-cols-1 lg:grid-cols-[280px_1fr]">
        <aside className="border-r border-slate-200 bg-slate-950 px-5 py-6 text-white">
          <div>
            <div className="text-xs uppercase tracking-[0.35em] text-sky-300">OdontoartPix</div>
            <h1 className="mt-2 text-xl font-semibold">Análise de mensalidades</h1>
          </div>
          <nav className="mt-8 space-y-2">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block rounded-xl px-4 py-3 text-sm text-slate-200 transition hover:bg-white/10 hover:text-white"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="min-w-0">
          <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
            <div>
              <p className="text-sm text-slate-500">Ambiente operacional</p>
              <p className="font-medium">{profile.nome ?? profile.email ?? "Usuário autenticado"}</p>
            </div>
            <div className="rounded-full bg-slate-100 px-4 py-2 text-sm text-slate-600">
              role: {profile.role ?? "não definido"}
            </div>
          </header>
          <main>{children}</main>
        </div>
      </div>
    </div>
  );
}
