import { MembersTable } from "@/components/members-table";
import { canAdmin, getCurrentProfile } from "@/lib/auth";
import { getMembers } from "@/lib/data";

export const dynamic = "force-dynamic";

function readSearchParamArray(value: string | string[] | undefined) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => item.trim()).filter(Boolean);
}

export default async function MembersPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const initialFilters = {
    query: typeof resolvedSearchParams.query === "string" ? resolvedSearchParams.query : "",
    code: typeof resolvedSearchParams.code === "string" ? resolvedSearchParams.code : "",
    installment:
      typeof resolvedSearchParams.installment === "string"
        ? resolvedSearchParams.installment
        : "",
    status: typeof resolvedSearchParams.status === "string" ? resolvedSearchParams.status : "all",
    payment:
      typeof resolvedSearchParams.payment === "string" ? resolvedSearchParams.payment : "all",
    campaign: readSearchParamArray(resolvedSearchParams.campaign),
    batch: readSearchParamArray(resolvedSearchParams.batch)
  };
  const [members, profile] = await Promise.all([
    getMembers({
      campaignIds: initialFilters.campaign,
      batchIds: initialFilters.batch,
      status: initialFilters.status
    }),
    getCurrentProfile()
  ]);

  return (
    <main className="p-6">
      <h1 className="text-3xl font-semibold">Associados</h1>
      <p className="mt-2 max-w-3xl text-sm text-slate-600">
        Consulte CodigoAssociadoEmpresa, parcela, CPF, campanha, lote, status e pendencias.
        Use os filtros ou clique nos cabecalhos para ordenar.
      </p>
      <div className="mt-6">
        <MembersTable
          members={members}
          initialFilters={initialFilters}
          canReprocessErrors={canAdmin(profile?.role)}
        />
      </div>
    </main>
  );
}
