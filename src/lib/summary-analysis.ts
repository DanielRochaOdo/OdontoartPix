import { dbQuery } from "@/lib/db/pool";

export type SummaryAnalysisEntityMetrics = {
  dispatchValueCents: number;
  paidAssociateCount: number;
  paidInstallmentCount: number;
  paidAmountCents: number;
};

export type SummaryAnalysisPixMetrics = SummaryAnalysisEntityMetrics;

export type SummaryAnalysisMetrics = {
  from: string;
  to: string;
  paymentDateFrom: string;
  paymentDateTo: string;
  campaignIds: string[];
  batchIds: string[];
  clinico: SummaryAnalysisEntityMetrics;
  orto: SummaryAnalysisEntityMetrics;
  robo: SummaryAnalysisPixMetrics;
  roboClinico: SummaryAnalysisPixMetrics;
  roboOrto: SummaryAnalysisPixMetrics;
};

export type SummaryAnalysisFilterOptions = {
  campaigns: Array<{ id: string; name: string }>;
  batches: Array<{ id: string; name: string; campaignId: string }>;
};

type SummaryAnalysisFilters = {
  from?: string;
  to?: string;
  paymentDateFrom?: string;
  paymentDateTo?: string;
  campaignIds?: string[];
  batchIds?: string[];
};

type MetricsRow = {
  clinico_dispatch_value_cents: number;
  clinico_paid_associates: number;
  clinico_paid_installments: number;
  clinico_paid_amount_cents: number;
  orto_dispatch_value_cents: number;
  orto_paid_associates: number;
  orto_paid_installments: number;
  orto_paid_amount_cents: number;
  pix_dispatch_value_cents: number;
  pix_paid_associates: number;
  pix_paid_installments: number;
  pix_paid_amount_cents: number;
  pix_clinico_dispatch_value_cents: number;
  pix_clinico_paid_associates: number;
  pix_clinico_paid_installments: number;
  pix_clinico_paid_amount_cents: number;
  pix_orto_dispatch_value_cents: number;
  pix_orto_paid_associates: number;
  pix_orto_paid_installments: number;
  pix_orto_paid_amount_cents: number;
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeIds(values?: string[]) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function validateSummaryAnalysisRange(from = "", to = "") {
  if ((from && !DATE_KEY.test(from)) || (to && !DATE_KEY.test(to))) {
    throw new Error("Periodo invalido.");
  }

  if (!from || !to) return;

  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
    throw new Error("Periodo invalido.");
  }
}

export async function getSummaryAnalysisFilterOptions(): Promise<SummaryAnalysisFilterOptions> {
  const [campaigns, batches] = await Promise.all([
    dbQuery<{ id: string; name: string }>(
      `select id, name
         from campaigns
        where deleted_at is null
        order by created_at desc, name asc`
    ),
    dbQuery<{ id: string; name: string; campaign_id: string }>(
      `select cb.id, cb.name, cb.campaign_id
         from campaign_batches cb
         join campaigns c on c.id = cb.campaign_id and c.deleted_at is null
        where cb.deleted_at is null
        order by cb.created_at desc, cb.name asc`
    )
  ]);

  return {
    campaigns: campaigns.rows.map((row) => ({ id: row.id, name: row.name })),
    batches: batches.rows.map((row) => ({
      id: row.id,
      name: row.name,
      campaignId: row.campaign_id
    }))
  };
}

export async function getSummaryAnalysisMetrics(
  filters: SummaryAnalysisFilters = {}
): Promise<SummaryAnalysisMetrics> {
  const from = filters.from?.trim() ?? "";
  const to = filters.to?.trim() ?? "";
  const paymentDateFrom = filters.paymentDateFrom?.trim() ?? "";
  const paymentDateTo = filters.paymentDateTo?.trim() ?? "";
  const campaignIds = sanitizeIds(filters.campaignIds);
  const batchIds = sanitizeIds(filters.batchIds);
  validateSummaryAnalysisRange(from, to);
  validateSummaryAnalysisRange(paymentDateFrom, paymentDateTo);

  const result = await dbQuery<MetricsRow>(
    `with scoped_targets as (
       select distinct cbm.target_installment_ref_id
         from campaign_batch_members cbm
         join campaigns c
           on c.id = cbm.campaign_id
          and c.deleted_at is null
         join campaign_batches cb
           on cb.id = cbm.batch_id
          and cb.deleted_at is null
        where cbm.deleted_at is null
          and cbm.target_installment_ref_id is not null
          and (cardinality($1::uuid[]) = 0 or cbm.campaign_id = any($1::uuid[]))
          and (cardinality($2::uuid[]) = 0 or cbm.batch_id = any($2::uuid[]))
     ), canonical as (
       select
         mti.member_id,
         mti.installment_type,
         mti.amount_cents,
         mti.paid_amount_cents,
         nullif(trim(mti.payment_description), '') as payment_description,
         case
           when trim(coalesce(mti.due_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{4}$'
             then to_date(trim(mti.due_date_text), 'DD/MM/YYYY')
           when trim(coalesce(mti.due_date_text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}'
             then to_date(substring(trim(mti.due_date_text) from 1 for 10), 'YYYY-MM-DD')
           when trim(coalesce(mti.due_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{2}$'
             then to_date(trim(mti.due_date_text), 'MM/DD/YY')
           else null
         end as due_date,
         case
           when trim(coalesce(mti.payment_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{4}$'
             then to_date(trim(mti.payment_date_text), 'DD/MM/YYYY')
           when trim(coalesce(mti.payment_date_text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}'
             then to_date(substring(trim(mti.payment_date_text) from 1 for 10), 'YYYY-MM-DD')
           when trim(coalesce(mti.payment_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{2}$'
             then to_date(trim(mti.payment_date_text), 'MM/DD/YY')
           else null
         end as payment_date
       from scoped_targets
       join member_target_installments mti
         on mti.id = scoped_targets.target_installment_ref_id
       join members m
         on m.id = mti.member_id
        and m.deleted_at is null
     ), ranged as (
       select
         *,
         (
           paid_amount_cents is not null
           and payment_description is not null
           and upper(payment_description) <> 'ABERTO'
           and upper(payment_description) <> 'ACORDADO'
           and upper(payment_description) <> 'EXCLUIDA'
         ) as is_paid,
         upper(trim(payment_description)) in (
           'PIX',
           'PIX - CLINICO',
           'PIX - ORTODONTIA',
           'PIX NEW ODONTO - P4X',
           'PIX NEW ODONTOLOGIA - P4X',
           'PIX ODONTOART - P4X',
           'PIX RECORRENTE ODONTOART - P4X'
         ) as is_pix
       from canonical
       where ($3::date is null or due_date >= $3::date)
         and ($4::date is null or due_date <= $4::date)
         and ($5::date is null or payment_date >= $5::date)
         and ($6::date is null or payment_date <= $6::date)
     )
     select
       coalesce(sum(amount_cents) filter (
         where installment_type = 'clinico'
       ), 0)::float8 as clinico_dispatch_value_cents,
       count(distinct member_id) filter (
         where is_paid and installment_type = 'clinico'
       )::int as clinico_paid_associates,
       count(*) filter (
         where is_paid and installment_type = 'clinico'
       )::int as clinico_paid_installments,
       coalesce(sum(paid_amount_cents) filter (
         where is_paid and installment_type = 'clinico'
       ), 0)::float8 as clinico_paid_amount_cents,

       coalesce(sum(amount_cents) filter (
         where installment_type = 'orto'
       ), 0)::float8 as orto_dispatch_value_cents,
       count(distinct member_id) filter (
         where is_paid and installment_type = 'orto'
       )::int as orto_paid_associates,
       count(*) filter (
         where is_paid and installment_type = 'orto'
       )::int as orto_paid_installments,
       coalesce(sum(paid_amount_cents) filter (
         where is_paid and installment_type = 'orto'
       ), 0)::float8 as orto_paid_amount_cents,

       coalesce(sum(amount_cents) filter (
         where installment_type in ('clinico', 'orto')
       ), 0)::float8 as pix_dispatch_value_cents,
       count(distinct member_id) filter (
         where is_paid and is_pix and installment_type in ('clinico', 'orto')
       )::int as pix_paid_associates,
       count(*) filter (
         where is_paid and is_pix and installment_type in ('clinico', 'orto')
       )::int as pix_paid_installments,
       coalesce(sum(paid_amount_cents) filter (
         where is_paid and is_pix and installment_type in ('clinico', 'orto')
       ), 0)::float8 as pix_paid_amount_cents,

       coalesce(sum(amount_cents) filter (
         where installment_type = 'clinico'
       ), 0)::float8 as pix_clinico_dispatch_value_cents,
       count(distinct member_id) filter (
         where is_paid and is_pix and installment_type = 'clinico'
       )::int as pix_clinico_paid_associates,
       count(*) filter (
         where is_paid and is_pix and installment_type = 'clinico'
       )::int as pix_clinico_paid_installments,
       coalesce(sum(paid_amount_cents) filter (
         where is_paid and is_pix and installment_type = 'clinico'
       ), 0)::float8 as pix_clinico_paid_amount_cents,

       coalesce(sum(amount_cents) filter (
         where installment_type = 'orto'
       ), 0)::float8 as pix_orto_dispatch_value_cents,
       count(distinct member_id) filter (
         where is_paid and is_pix and installment_type = 'orto'
       )::int as pix_orto_paid_associates,
       count(*) filter (
         where is_paid and is_pix and installment_type = 'orto'
       )::int as pix_orto_paid_installments,
       coalesce(sum(paid_amount_cents) filter (
         where is_paid and is_pix and installment_type = 'orto'
       ), 0)::float8 as pix_orto_paid_amount_cents
     from ranged`,
    [campaignIds, batchIds, from || null, to || null, paymentDateFrom || null, paymentDateTo || null]
  );

  const row = result.rows[0];
  const entity = (
    dispatchValueCents: number | undefined,
    paidAssociateCount: number | undefined,
    paidInstallmentCount: number | undefined,
    paidAmountCents: number | undefined
  ): SummaryAnalysisEntityMetrics => ({
    dispatchValueCents: Number(dispatchValueCents ?? 0),
    paidAssociateCount: Number(paidAssociateCount ?? 0),
    paidInstallmentCount: Number(paidInstallmentCount ?? 0),
    paidAmountCents: Number(paidAmountCents ?? 0)
  });

  return {
    from,
    to,
    paymentDateFrom,
    paymentDateTo,
    campaignIds,
    batchIds,
    clinico: entity(
      row?.clinico_dispatch_value_cents,
      row?.clinico_paid_associates,
      row?.clinico_paid_installments,
      row?.clinico_paid_amount_cents
    ),
    orto: entity(
      row?.orto_dispatch_value_cents,
      row?.orto_paid_associates,
      row?.orto_paid_installments,
      row?.orto_paid_amount_cents
    ),
    robo: entity(
      row?.pix_dispatch_value_cents,
      row?.pix_paid_associates,
      row?.pix_paid_installments,
      row?.pix_paid_amount_cents
    ),
    roboClinico: entity(
      row?.pix_clinico_dispatch_value_cents,
      row?.pix_clinico_paid_associates,
      row?.pix_clinico_paid_installments,
      row?.pix_clinico_paid_amount_cents
    ),
    roboOrto: entity(
      row?.pix_orto_dispatch_value_cents,
      row?.pix_orto_paid_associates,
      row?.pix_orto_paid_installments,
      row?.pix_orto_paid_amount_cents
    )
  };
}
