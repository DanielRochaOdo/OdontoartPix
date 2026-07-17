export default async function MemberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="p-6">
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">Associado</p>
      <h1 className="mt-2 text-3xl font-semibold">Detalhe do associado</h1>
      <p className="mt-2 text-sm text-slate-600">ID: {id}</p>

      <section className="mt-6 grid gap-4 xl:grid-cols-3">
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
          <h2 className="text-lg font-semibold">Dados e análise</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-slate-50 p-3 text-sm">CPF: ***.***.***-00</div>
            <div className="rounded-xl bg-slate-50 p-3 text-sm">Status: pendente</div>
            <div className="rounded-xl bg-slate-50 p-3 text-sm">Valor pendente: R$ 0,00</div>
            <div className="rounded-xl bg-slate-50 p-3 text-sm">Tentativas: 0</div>
          </div>
        </article>

        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Histórico</h2>
          <div className="mt-4 rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
            Nenhuma consulta registrada.
          </div>
        </article>
      </section>
    </main>
  );
}
