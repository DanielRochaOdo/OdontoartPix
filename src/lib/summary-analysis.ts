import { dbQuery } from "@/lib/db/pool";

export type SummaryAnalysisEntityMetrics = {
  paidAssociateCount: number;
  paidInstallmentCount: number;
  paidAmountCents: number;
};

export type SummaryAnalysisPixMetrics = SummaryAnalysisEntityMetrics;

export type SummaryAnalysisMetrics = {
  from: string;
  to: string;
  clinico: SummaryAnalysisEntityMetrics;
  orto: SummaryAnalysisEntityMetrics;
  robo: SummaryAnalysisPixMetrics;
};

type MetricsRow = {
  clinico_paid_associates: number;
  clinico_paid_installments: number;
  clinico_paid_amount_cents: number;
  orto_paid_associates: number;
  orto_paid_installments: number;
  orto_paid_amount_cents: number;
  pix_paid_associates: number;
  pix_paid_installments: number;
  pix_paid_amount_cents: number;
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function validateSummaryAnalysisRange(from: string, to: string) {
  if (!DATE_KEY.test(from) || !DATE_KEY.test(to)) {
    throw new Error("Periodo invalido.");
  }

  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
    throw new Error("Periodo invalido.");
  }
}

export async function getSummaryAnalysisMetrics(
  from: string,
  to: string
): Promise<SummaryAnalysisMetrics> {
  validateSummaryAnalysisRange(from, to);

  const result = await dbQuery<MetricsRow>(
    `with canonical as (
       select
         mti.member_id,
         mti.installment_type,
         mti.paid_amount_cents,
         nullif(trim(mti.payment_description), '') as payment_description,
         case
           when trim(coalesce(mti.payment_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{4}$'
             then to_date(trim(mti.payment_date_text), 'DD/MM/YYYY')
           when trim(coalesce(mti.payment_date_text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}'
             then to_date(substring(trim(mti.payment_date_text) from 1 for 10), 'YYYY-MM-DD')
           when trim(coalesce(mti.payment_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{2}$'
             then to_date(trim(mti.payment_date_text), 'MM/DD/YY')
           else null
         end as payment_date
       from member_target_installments mti
       join members m
         on m.id = mti.member_id
        and m.deleted_at is null
     ), ranged as (
       select *
         from canonical
        where payment_date between $1::date and $2::date
     ), paid as (
       select *
         from ranged
        where paid_amount_cents is not null
          and payment_description is not null
          and upper(payment_description) <> 'ABERTO'
          and upper(payment_description) <> 'ACORDADO'
     )
     select
       count(distinct member_id) filter (
         where installment_type = 'clinico'
       )::int as clinico_paid_associates,
       count(*) filter (
         where installment_type = 'clinico'
       )::int as clinico_paid_installments,
       coalesce(sum(paid_amount_cents) filter (
         where installment_type = 'clinico'
       ), 0)::float8 as clinico_paid_amount_cents,
       count(distinct member_id) filter (
         where installment_type = 'orto'
       )::int as orto_paid_associates,
       count(*) filter (
         where installment_type = 'orto'
       )::int as orto_paid_installments,
       coalesce(sum(paid_amount_cents) filter (
         where installment_type = 'orto'
       ), 0)::float8 as orto_paid_amount_cents,
       count(distinct member_id) filter (
         where upper(payment_description) like '%PIX%'
       )::int as pix_paid_associates,
       count(*) filter (
         where upper(payment_description) like '%PIX%'
       )::int as pix_paid_installments,
       coalesce(sum(paid_amount_cents) filter (
         where upper(payment_description) like '%PIX%'
       ), 0)::float8 as pix_paid_amount_cents
     from paid`,
    [from, to]
  );

  const row = result.rows[0];
  return {
    from,
    to,
    clinico: {
      paidAssociateCount: Number(row?.clinico_paid_associates ?? 0),
      paidInstallmentCount: Number(row?.clinico_paid_installments ?? 0),
      paidAmountCents: Number(row?.clinico_paid_amount_cents ?? 0)
    },
    orto: {
      paidAssociateCount: Number(row?.orto_paid_associates ?? 0),
      paidInstallmentCount: Number(row?.orto_paid_installments ?? 0),
      paidAmountCents: Number(row?.orto_paid_amount_cents ?? 0)
    },
    robo: {
      paidAssociateCount: Number(row?.pix_paid_associates ?? 0),
      paidInstallmentCount: Number(row?.pix_paid_installments ?? 0),
      paidAmountCents: Number(row?.pix_paid_amount_cents ?? 0)
    }
  };
}
