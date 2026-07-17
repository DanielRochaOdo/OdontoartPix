import Link from "next/link";
import { MemberActions } from "@/components/member-actions";
import { getMembers } from "@/lib/data";

export default async function MembersPage() {
  const members = await getMembers();

  return (
    <main className="p-6">
      <h1 className="text-3xl font-semibold">Associados</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Base para consulta, histórico, reprocessamento e exportação.
      </p>
      <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Nome</th>
              <th className="px-4 py-3 text-left font-medium">CPF</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Pendência</th>
              <th className="px-4 py-3 text-left font-medium">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {members.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  Nenhum associado encontrado.
                </td>
              </tr>
            ) : (
              members.map((item) => {
                const member = Array.isArray(item.member) ? item.member[0] : item.member;
                return (
                  <tr key={item.id}>
                    <td className="px-4 py-3 font-medium">{member?.name ?? "Sem nome"}</td>
                    <td className="px-4 py-3">{member?.cpf ? `***.***.***-${member.cpf.slice(-2)}` : "-"}</td>
                    <td className="px-4 py-3">{item.payment_status ?? item.processing_status}</td>
                    <td className="px-4 py-3">R$ {(item.total_pending_amount_cents / 100).toFixed(2).replace(".", ",")}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <Link className="rounded-md border px-3 py-1.5 text-sm" href={`/associados/${item.id}`}>
                          Abrir
                        </Link>
                        <MemberActions memberId={item.id} />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
