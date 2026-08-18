-- O grafico de recebimentos usa todas as parcelas ativas do sistema. A
-- reconciliacao inicial reabre os associados que antes eram considerados pagos
-- para que o contrato de historico completo atualize ValorPago e
-- DescricaoRecebimento uma unica vez.

create table if not exists public.dashboard_receipt_status_reconciliation (
  reconciliation_key text primary key,
  status text not null default 'pending',
  prepared_member_count bigint not null default 0,
  prepared_at timestamptz,
  constraint dashboard_receipt_status_reconciliation_status_check
    check (status in ('pending', 'started'))
);

insert into public.dashboard_receipt_status_reconciliation(reconciliation_key)
values ('initial_paid_members')
on conflict (reconciliation_key) do nothing;

create or replace function public.prepare_initial_receipt_status_reconciliation_v1()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.dashboard_receipt_status_reconciliation;
  v_paid_member_count bigint := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('initial-paid-receipt-status-reconciliation', 0));

  select * into v_state
  from public.dashboard_receipt_status_reconciliation
  where reconciliation_key = 'initial_paid_members'
  for update;

  if v_state.status = 'started' then
    return jsonb_build_object(
      'started', false,
      'status', v_state.status,
      'preparedMemberCount', v_state.prepared_member_count
    );
  end if;

  select count(*)::bigint
    into v_paid_member_count
  from public.campaign_batch_members cbm
  where cbm.deleted_at is null
    and cbm.payment_status = 'paid'
    and coalesce(cbm.processing_status, '') <> 'processing';

  update public.campaign_batch_members cbm
  set payment_status = null,
      payment_status_source = null,
      processing_status = 'pending',
      total_pending_amount_cents = 0,
      next_check_at = null,
      next_retry_at = null,
      last_error = null,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null,
      updated_at = now()
  where cbm.deleted_at is null
    and cbm.payment_status = 'paid'
    and coalesce(cbm.processing_status, '') <> 'processing';

  update public.dashboard_receipt_status_reconciliation
  set status = 'started',
      prepared_member_count = v_paid_member_count,
      prepared_at = now()
  where reconciliation_key = 'initial_paid_members';

  return jsonb_build_object(
    'started', true,
    'status', 'started',
    'preparedMemberCount', v_paid_member_count
  );
end;
$$;

revoke all on function public.prepare_initial_receipt_status_reconciliation_v1()
  from public, anon, authenticated;
grant execute on function public.prepare_initial_receipt_status_reconciliation_v1()
  to service_role;

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
      coalesce(nullif(trim(mi.situation), ''), 'Sem descricao') as label,
      count(*)::integer as installment_count,
      coalesce(sum(coalesce(mi.paid_amount_cents, mi.final_amount_cents)), 0)::bigint as amount_cents
    from public.member_installments mi
    join public.campaign_batch_members cbm on cbm.id = mi.campaign_batch_member_id
    join public.campaign_batches cb on cb.id = cbm.batch_id and cb.deleted_at is null
    join public.campaigns c on c.id = cb.campaign_id and c.deleted_at is null
    where cbm.deleted_at is null
    group by coalesce(nullif(trim(mi.situation), ''), 'Sem descricao')
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
