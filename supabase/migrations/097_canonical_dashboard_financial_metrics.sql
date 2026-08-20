-- Consolida todos os indicadores financeiros do Dashboard na mesma fonte de
-- verdade da parcela alvo.
--
-- Contrato financeiro:
--   Valor da parcela / valor total = API.Valor (target_amount_cents)
--   Valor recebido                 = API.ValorPago (target_paid_amount_cents)
--   Pago                           = ValorPago + DescricaoRecebimento != ABERTO
--   Pendente                       = API.Valor quando a ultima verdade confirmada
--                                    da target for unpaid
--
-- O estado tecnico de processamento e independente do estado financeiro. Uma
-- nova tentativa/retry/erro nao remove dos cards a ultima verdade ERP ja
-- confirmada. Registros ainda sem verdade financeira confirmada nao sao
-- inferidos como pagos nem como nao pagos.

create or replace function public.get_dashboard_metrics(
  p_campaign_ids uuid[] default null,
  p_batch_ids uuid[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with selected_campaigns as (
    select c.id
      from public.campaigns c
     where c.deleted_at is null
       and (
         p_campaign_ids is null
         or cardinality(p_campaign_ids) = 0
         or c.id = any(p_campaign_ids)
       )
  ),
  selected_batches as (
    select cb.id, cb.campaign_id
      from public.campaign_batches cb
     where cb.deleted_at is null
       and cb.campaign_id in (select id from selected_campaigns)
       and (
         p_batch_ids is null
         or cardinality(p_batch_ids) = 0
         or cb.id = any(p_batch_ids)
       )
  ),
  target_rows as (
    select
      truth.campaign_batch_member_id,
      truth.member_id,
      truth.processing_status,
      truth.stored_payment_status,
      truth.target_amount_cents,
      truth.target_paid_amount_cents,
      truth.target_open_amount_cents,
      truth.is_explicit_paid,
      case
        when truth.is_explicit_paid then 'paid'
        when truth.stored_payment_status = 'unpaid' then 'unpaid'
        else null
      end as financial_status
    from public.target_installment_payment_v1 truth
    where truth.campaign_id in (select id from selected_campaigns)
      and truth.batch_id in (select id from selected_batches)
  ),
  campaign_metrics as (
    select count(*)::integer as total_campaigns
      from selected_campaigns
  ),
  member_metrics as (
    select
      count(*)::integer as total_cpfs,
      count(distinct member_id)::integer as unique_cpfs,
      count(*) filter (where financial_status = 'paid')::integer as paid,
      count(*) filter (where financial_status = 'unpaid')::integer as unpaid,
      count(*) filter (where processing_status = 'error')::integer as errored,
      coalesce(
        sum(target_open_amount_cents) filter (where financial_status = 'unpaid'),
        0
      )::bigint as pending_amount,
      coalesce(
        sum(target_paid_amount_cents) filter (where financial_status = 'paid'),
        0
      )::bigint as paid_amount,
      coalesce(sum(target_amount_cents), 0)::bigint as total_amount
    from target_rows
  ),
  job_metrics as (
    select count(distinct pj.campaign_id)::integer as campaigns_in_progress
      from public.processing_jobs pj
     where pj.status in ('queued', 'running')
       and pj.campaign_id in (select id from selected_campaigns)
       and pj.batch_id in (select id from selected_batches)
  )
  select jsonb_build_object(
    'totalCampaigns', c.total_campaigns,
    'campaignsInProgress', j.campaigns_in_progress,
    'uniqueCpfs', m.unique_cpfs,
    'totalCpfs', m.total_cpfs,
    'paid', m.paid,
    'unpaid', m.unpaid,
    'errored', m.errored,
    'utilizationPercentage',
      case
        when m.paid + m.unpaid = 0 then 0
        else round((m.paid::numeric / (m.paid + m.unpaid)) * 100, 2)
      end,
    'totalPendingAmountCents', m.pending_amount,
    'totalPaidAmountCents', m.paid_amount,
    'totalBatchAmountCents', m.total_amount
  )
  from campaign_metrics c
  cross join member_metrics m
  cross join job_metrics j;
$$;

revoke all on function public.get_dashboard_metrics(uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.get_dashboard_metrics(uuid[], uuid[])
  to service_role;

-- Recebimentos: somente a target explicitamente paga, agrupada pela descricao
-- recebida do ERP. O estado tecnico atual do associado nao interfere.
create or replace function public.get_dashboard_receipt_status_metrics(
  p_campaign_ids uuid[] default null,
  p_batch_ids uuid[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with grouped as (
    select
      truth.payment_description as label,
      count(*)::integer as installment_count,
      coalesce(sum(truth.target_paid_amount_cents), 0)::bigint as amount_cents
    from public.target_installment_payment_v1 truth
    join public.campaign_batches cb
      on cb.id = truth.batch_id
     and cb.deleted_at is null
    join public.campaigns c
      on c.id = truth.campaign_id
     and c.deleted_at is null
    where truth.is_explicit_paid
      and truth.payment_description is not null
      and (
        p_campaign_ids is null
        or cardinality(p_campaign_ids) = 0
        or truth.campaign_id = any(p_campaign_ids)
      )
      and (
        p_batch_ids is null
        or cardinality(p_batch_ids) = 0
        or truth.batch_id = any(p_batch_ids)
      )
    group by truth.payment_description
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'label', grouped.label,
        'installmentCount', grouped.installment_count,
        'amountCents', grouped.amount_cents
      )
      order by grouped.amount_cents desc, grouped.label asc
    ),
    '[]'::jsonb
  )
  from grouped;
$$;

revoke all on function public.get_dashboard_receipt_status_metrics(uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.get_dashboard_receipt_status_metrics(uuid[], uuid[])
  to service_role;

-- Valor pago via PIX: API.ValorPago exclusivamente das targets com pagamento
-- explicito cuja DescricaoRecebimento identifica PIX.
create or replace function public.get_dashboard_pix_paid_metrics(
  p_campaign_ids uuid[] default null,
  p_batch_ids uuid[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'pixPaidAmountCents',
    coalesce(sum(truth.target_paid_amount_cents), 0)::bigint
  )
  from public.target_installment_payment_v1 truth
  join public.campaign_batches cb
    on cb.id = truth.batch_id
   and cb.deleted_at is null
  join public.campaigns c
    on c.id = truth.campaign_id
   and c.deleted_at is null
  where truth.is_explicit_paid
    and truth.payment_description is not null
    and upper(trim(truth.payment_description)) like '%PIX%'
    and (
      p_campaign_ids is null
      or cardinality(p_campaign_ids) = 0
      or truth.campaign_id = any(p_campaign_ids)
    )
    and (
      p_batch_ids is null
      or cardinality(p_batch_ids) = 0
      or truth.batch_id = any(p_batch_ids)
    );
$$;

revoke all on function public.get_dashboard_pix_paid_metrics(uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.get_dashboard_pix_paid_metrics(uuid[], uuid[])
  to service_role;

comment on function public.get_dashboard_metrics(uuid[], uuid[]) is
  'Dashboard canonico: total/pendencia usam API.Valor; recebido usa API.ValorPago; estado tecnico nao apaga verdade financeira confirmada.';
comment on function public.get_dashboard_receipt_status_metrics(uuid[], uuid[]) is
  'Recebimentos da target explicitamente paga, independente do estado tecnico atual.';
comment on function public.get_dashboard_pix_paid_metrics(uuid[], uuid[]) is
  'PIX pago da target: soma API.ValorPago quando DescricaoRecebimento identifica PIX.';
