import { MembersTable } from "@/components/members-table";
import { canAdmin, getCurrentProfile } from "@/lib/auth";
import { getMembers } from "@/lib/data";
import { PageSurface } from "@/components/page-surface";
import { PageHeader } from "@/components/page-header";

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
    dueDateFrom:
      typeof resolvedSearchParams.dueDateFrom === "string"
        ? resolvedSearchParams.dueDateFrom
        : "",
    dueDateTo:
      typeof resolvedSearchParams.dueDateTo === "string"
        ? resolvedSearchParams.dueDateTo
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
    <PageSurface>
      <PageHeader
        eyebrow="Cadastros"
        title="Associados"
        description="Consulte CodigoAssociadoEmpresa, parcela, CPF, campanha, lote, status e pendencias. Use os filtros ou clique nos cabecalhos para ordenar."
      />
      <div className="mt-6">
        <MembersTable
          members={members}
          initialFilters={initialFilters}
          canReprocessErrors={canAdmin(profile?.role)}
        />
      </div>
    </PageSurface>
  );
}
