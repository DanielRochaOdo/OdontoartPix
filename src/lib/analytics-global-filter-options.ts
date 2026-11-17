import { dbQuery } from "@/lib/db/pool";
import type { AnalyticsPerfTrace } from "@/lib/analytics-performance";
import type { AssociadosFilterOptions } from "@/lib/associados-paginated";

/**
 * Read-only, unfiltered catalog for Visao Analitica ONLY.
 *
 * The old catalog ran ASSOCIADOS_CARD_BASE_SQL + FILTERED_SQL six times,
 * including date parsing, names, financial amounts, and representative links.
 * For the unfiltered catalog none of those enrichments are needed.
 *
 * Preserve the exact scope and normalization from getAssociadosCardFilterOptions({}):
 * active links -> one grouped canonical installment -> active member.
 * Entity facets use ALL eligible links, not the arbitrary representative link.
 */
export const ANALYTICS_GLOBAL_CATALOG_SQL = `
with active_links as materialized (
  select l.target_installment_ref_id, l.campaign_id, l.batch_id, l.processing_status
    from campaign_batch_members l
    join campaign_batches b on b.id = l.batch_id and b.deleted_at is null
    join campaigns c on c.id = l.campaign_id and c.deleted_at is null
   where l.deleted_at is null
     and l.target_installment_ref_id is not null
), grouped as (
  select target_installment_ref_id,
         case
           when bool_or(processing_status = 'error') then 'error'
           when bool_or(processing_status = 'processing') then 'processing'
           when bool_or(processing_status = 'retrying') then 'retrying'
           when bool_and(processing_status = 'completed') then 'completed'
           else 'pending'
         end as processing_status
    from active_links
   group by target_installment_ref_id
), normalized as materialized (
  select g.target_installment_ref_id,
         case translate(lower(trim(coalesce(g.processing_status, ''))),
               'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')
           when 'pendente' then 'pending'
           when 'processando' then 'processing'
           when 'concluido' then 'completed'
           when 'erro' then 'error'
           when 'falhou' then 'failed'
           when 'retry' then 'retrying'
           else coalesce(nullif(lower(trim(g.processing_status)), ''), '-')
         end as status_key,
         case translate(lower(trim(coalesce(t.payment_status, ''))),
               'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')
           when 'pago' then 'paid'
           when 'nao pago' then 'unpaid'
           when 'nao pagos' then 'unpaid'
           when 'not paid' then 'unpaid'
           when 'acordado' then 'agreed'
           when 'excluida' then 'excluded'
           when 'pendente' then 'pending'
           else coalesce(nullif(lower(trim(t.payment_status)), ''), '-')
         end as payment_key,
         case when t.payment_status = 'agreed' then '-'
              else coalesce(nullif(trim(t.payment_description), ''), '-')
         end as receipt_key,
         case lower(trim(coalesce(t.installment_type, '')))
           when 'clinico' then 'Clínico'
           when 'orto' then 'Orto'
           else '-'
         end as installment_type_label
    from grouped g
    join member_target_installments t on t.id = g.target_installment_ref_id
    join members m on m.id = t.member_id and m.deleted_at is null
), values_by_facet as (
  select 'status'::text as facet, status_key::text as value, status_key::text as label
    from normalized
  union all
  select 'payment', payment_key, payment_key from normalized
  union all
  select 'receipt', receipt_key, receipt_key from normalized
  union all
  select 'installmentType', installment_type_label, installment_type_label from normalized
  union all
  select 'campaign', c.id::text, c.name
    from active_links l
    join normalized n on n.target_installment_ref_id = l.target_installment_ref_id
    join campaigns c on c.id = l.campaign_id
  union all
  select 'batch', b.id::text, b.name
    from active_links l
    join normalized n on n.target_installment_ref_id = l.target_installment_ref_id
    join campaign_batches b on b.id = l.batch_id
)
select distinct facet, value, label
  from values_by_facet
 order by facet, label, value
`;

type CatalogFacet = keyof AssociadosFilterOptions;
type CatalogRow = { facet: CatalogFacet; value: string; label: string };

export async function getAnalyticsGlobalFilterOptions(
  trace?: AnalyticsPerfTrace | null
): Promise<AssociadosFilterOptions> {
  const load = () => dbQuery<CatalogRow>(ANALYTICS_GLOBAL_CATALOG_SQL);
  const result = trace ? await trace.measure("catalog_fast_query", load) : await load();
  const options: AssociadosFilterOptions = {
    status: [], payment: [], receipt: [], installmentType: [], campaign: [], batch: []
  };
  for (const row of result.rows) {
    if (Object.prototype.hasOwnProperty.call(options, row.facet)) {
      options[row.facet].push({ value: row.value, label: row.label });
    }
  }
  return options;
}
