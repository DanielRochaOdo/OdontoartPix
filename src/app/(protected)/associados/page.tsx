import { AssociadosCardList } from "@/components/associados-card-list";
import { PageHeader } from "@/components/page-header";
import { PageSurface } from "@/components/page-surface";
import { getAssociadosCardList } from "@/lib/associados-card-read";
import { canAdmin, getCurrentProfile } from "@/lib/auth";

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
    status: readSearchParamArray(resolvedSearchParams.status),
    payment: readSearchParamArray(resolvedSearchParams.payment),
    paidPending:
      typeof resolvedSearchParams.paidPending === "string"
        ? resolvedSearchParams.paidPending
        : "all",
    receipt: readSearchParamArray(resolvedSearchParams.receipt),
    campaign: readSearchParamArray(resolvedSearchParams.campaign),
    batch: readSearchParamArray(resolvedSearchParams.batch)
  };

  const [members, profile] = await Promise.all([
    getAssociadosCardList({
      campaignIds: initialFilters.campaign,
      batchIds: initialFilters.batch,
      status: initialFilters.status.length === 1 ? initialFilters.status[0] : "all"
    }),
    getCurrentProfile()
  ]);

  return (
    <PageSurface className="lg:px-5 xl:px-6">
      <PageHeader
        eyebrow="Cadastros"
        title="Associados"
        description="Consulte CodigoAssociadoEmpresa, parcela, CPF, campanha, lote, status e pendencias. Use os filtros para localizar os registros e ordenar a listagem."
      />
      <div className="mt-6">
        <AssociadosCardList
          members={members}
          initialFilters={initialFilters}
          canReprocessErrors={canAdmin(profile?.role)}
        />
      </div>
    </PageSurface>
  );
}
