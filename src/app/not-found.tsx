import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6 text-slate-950">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">404</p>
        <h1 className="mt-3 text-2xl font-semibold">Página não encontrada</h1>
        <p className="mt-2 text-sm text-slate-600">
          A rota solicitada não existe ou foi removida.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white"
        >
          Voltar ao dashboard
        </Link>
      </div>
    </main>
  );
}
