export default function DashboardPage() {
  const cards = [
    { label: "Campanhas cadastradas", value: "0" },
    { label: "Campanhas em andamento", value: "0" },
    { label: "CPFs consolidados", value: "0" },
    { label: "Pagos", value: "0" },
    { label: "Não pagos", value: "0" },
    { label: "Erros", value: "0" },
    { label: "Aproveitamento", value: "0%" },
    { label: "Valor pendente", value: "R$ 0,00" }
  ];

  return (
    <main className="p-6">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">Visão geral</p>
        <h1 className="mt-2 text-3xl font-semibold">Dashboard operacional</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Indicadores consolidados de campanhas, processamento e pendências financeiras.
        </p>
      </header>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <article key={card.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm text-slate-500">{card.label}</p>
            <div className="mt-3 text-2xl font-semibold">{card.value}</div>
            <div className="mt-4 h-1.5 rounded-full bg-slate-100">
              <div className="h-1.5 w-1/3 rounded-full bg-sky-500" />
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
