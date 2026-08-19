-- Corrige as regressões introduzidas pelo histórico completo:
-- 1) uma única fonte de verdade financeira para target_installment_id;
-- 2) pagamento exige ValorPago + DescricaoRecebimento != ABERTO;
-- 3) pagamento parcial preserva saldo pendente;
-- 4) persistência individual e em onda convergem para a mesma regra;
-- 5) jobs manuais e do dashboard não compartilham unicidade por origem.

alter table if exists public.member_installments
  add column if not exists payment_description text;

update public.member_installments
   set payment_description = nullif(trim(situation), '')
 where payment_description is null
   and nullif(trim(situation), '') is not null;

create or replace function public.sync_installment_payment_description_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if nullif(trim(new.payment_description), '') is null
     and nullif(trim(new.situation), '') is not null then
    new.payment_description := nullif(trim(new.situation), '');
  end if;

  -- Mantém compatibilidade com telas/RPCs antigas até que situation seja
  -- completamente removido do contrato de recebimento.
  if nullif(trim(new.situation), '') is null
     and nullif(trim(new.payment_description), '') is not null then
    new.situation := nullif(trim(new.payment_description), '');
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_installment_payment_description_v1
  on public.member_installments;
create trigger trg_sync_installment_payment_description_v1
before insert or update of situation, payment_description
on public.member_installments
for each row
execute function public.sync_installment_payment_description_v1();

create index if not exists idx_member_installments_target_lookup_v1
  on public.member_installments(
    campaign_batch_member_id,
    cod_parcela,
    updated_at desc,
    created_at desc
  );

-- A unicidade anterior era por lote e fazia uma origem reutilizar/impedir a
-- outra. A nova unicidade é por lote + origem. O código ainda impede execução
-- simultânea de origens diferentes enquanto ambas estiverem ativas, mas um
-- dashboard pausado não bloqueia um job manual.
drop index if exists public.uq_processing_jobs_one_active_per_batch;
drop index if exists public.uq_processing_jobs_one_active_per_origin;
create unique index uq_processing_jobs_one_active_per_origin
  on public.processing_jobs(batch_id, processing_origin)
  where status in ('queued', 'running');

-- A constraint antiga lançava exceção durante a persistência intermediária da
-- onda: o vínculo podia receber paid antes do enriquecimento de ValorPago.
-- Normalizamos a escrita intermediária para unpaid e a atualização final, já
-- com a evidência persistida, promove para paid.
drop trigger if exists trg_enforce_target_explicit_payment_v1
  on public.campaign_batch_members;

create or replace function public.normalize_target_explicit_payment_v2()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.processing_status = 'completed'
     and new.payment_status = 'paid'
     and not exists (
       select 1
       from public.member_installments mi
       where mi.campaign_batch_member_id = new.id
         and trim(mi.cod_parcela) = trim(new.target_installment_id)
         and mi.paid_amount_cents is not null
         and nullif(trim(coalesce(mi.payment_description, mi.situation)), '') is not null
         and upper(trim(coalesce(mi.payment_description, mi.situation))) <> 'ABERTO'
     ) then
    new.payment_status := 'unpaid';
    new.payment_status_source := 'erp_open_invoice';
    new.payment_amount_cents := 0;
  end if;
  return new;
end;
$$;

create trigger trg_normalize_target_explicit_payment_v2
before insert or update of processing_status, payment_status, target_installment_id
on public.campaign_batch_members
for each row
execute function public.normalize_target_explicit_payment_v2();

create or replace view public.target_installment_payment_v1
as
select
  cbm.id as campaign_batch_member_id,
  cbm.campaign_id,
  cbm.batch_id,
  cbm.member_id,
  cbm.target_installment_id,
  cbm.processing_status,
  cbm.payment_status as stored_payment_status,
  cbm.payment_status_source,
  coalesce(nullif(target.final_amount_cents, 0), cbm.installment_amount_cents, 0)::bigint
    as target_amount_cents,
  target.paid_amount_cents as target_paid_amount_cents,
  nullif(trim(coalesce(target.payment_description, target.situation)), '')
    as payment_description,
  (
    target.paid_amount_cents is not null
    and nullif(trim(coalesce(target.payment_description, target.situation)), '') is not null
    and upper(trim(coalesce(target.payment_description, target.situation))) <> 'ABERTO'
  ) as is_explicit_paid,
  case
    when target.paid_amount_cents is not null
      and nullif(trim(coalesce(target.payment_description, target.situation)), '') is not null
      and upper(trim(coalesce(target.payment_description, target.situation))) <> 'ABERTO'
    then greatest(
      coalesce(nullif(target.final_amount_cents, 0), cbm.installment_amount_cents, 0)::bigint
      - target.paid_amount_cents,
      0
    )
    else coalesce(nullif(target.final_amount_cents, 0), cbm.installment_amount_cents, 0)::bigint
  end as target_open_amount_cents,
  target.id as target_installment_row_id,
  target.updated_at as target_installment_updated_at
from public.campaign_batch_members cbm
left join lateral (
  select
    mi.id,
    mi.final_amount_cents,
    mi.paid_amount_cents,
    mi.payment_description,
    mi.situation,
    mi.updated_at,
    mi.created_at
  from public.member_installments mi
  where mi.campaign_batch_member_id = cbm.id
    and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
  order by mi.updated_at desc, mi.created_at desc, mi.id desc
  limit 1
) target on true
where cbm.deleted_at is null;

grant select on public.target_installment_payment_v1 to service_role;

-- Qualquer paid legado/irregular sem evidência explícita volta à fila uma vez.
update public.campaign_batch_members cbm
set payment_status = null,
    payment_status_source = null,
    processing_status = 'pending',
    payment_amount_cents = null,
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
  and not exists (
    select 1
    from public.member_installments mi
    where mi.campaign_batch_member_id = cbm.id
      and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
      and mi.paid_amount_cents is not null
      and nullif(trim(coalesce(mi.payment_description, mi.situation)), '') is not null
      and upper(trim(coalesce(mi.payment_description, mi.situation))) <> 'ABERTO'
  );

-- Persistência usada pelo reprocessamento individual. O resumo financeiro do
-- vínculo é calculado exclusivamente a partir da target, nunca da soma do
-- histórico completo.
create or replace function public.persist_member_processing_success(
  p_campaign_batch_member_id uuid,
  p_http_status integer,
  p_duration_ms integer,
  p_analysis jsonb,
  p_recalculate boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
  v_batch_id uuid;
  v_target_installment_id text;
  v_attempt integer;
  v_count integer;
  v_target_amount bigint := 0;
  v_target_paid bigint;
  v_payment_description text;
  v_explicit_paid boolean := false;
  v_open_amount bigint := 0;
begin
  select campaign_id, batch_id, target_installment_id, processing_attempts
    into v_campaign_id, v_batch_id, v_target_installment_id, v_attempt
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_batch_member_not_found';
  end if;

  v_count := coalesce((p_analysis->>'installmentsCount')::integer, 0);

  delete from public.member_installments
  where campaign_batch_member_id = p_campaign_batch_member_id;

  insert into public.member_installments(
    campaign_batch_member_id, cod_usuario, cod_parcela, due_date_text,
    installment_type, boleto_code, pix_code, card_payment_link, situation,
    payment_description, base_amount_cents, fine_amount_cents,
    interest_amount_cents, additional_amount_cents, discount_amount_cents,
    final_amount_cents, plan_type, observation, paid_amount_cents
  )
  select
    p_campaign_batch_member_id,
    nullif(item->>'userCode', ''),
    item->>'installmentCode',
    nullif(item->>'dueDate', ''),
    nullif(item->>'installmentType', ''),
    nullif(item->>'boletoCode', ''),
    nullif(item->>'pixCode', ''),
    nullif(item->>'cardPaymentLink', ''),
    nullif(coalesce(item->>'paymentDescription', item->>'situation'), ''),
    nullif(coalesce(item->>'paymentDescription', item->>'situation'), ''),
    coalesce((item->>'baseAmountCents')::bigint, 0),
    coalesce((item->>'fineAmountCents')::bigint, 0),
    coalesce((item->>'interestAmountCents')::bigint, 0),
    coalesce((item->>'additionalAmountCents')::bigint, 0),
    coalesce((item->>'discountAmountCents')::bigint, 0),
    coalesce((item->>'finalAmountCents')::bigint, 0),
    coalesce(nullif(item->>'planType', ''), 'Nao informado'),
    nullif(item->>'observation', ''),
    case
      when nullif(item->>'paidAmountCents', '') is not null
      then (item->>'paidAmountCents')::bigint
      else null
    end
  from jsonb_array_elements(coalesce(p_analysis->'installments', '[]'::jsonb)) item;

  delete from public.member_plan_totals
  where campaign_batch_member_id = p_campaign_batch_member_id;

  insert into public.member_plan_totals(
    campaign_batch_member_id, plan_type, installments_count, total_amount_cents
  )
  select
    p_campaign_batch_member_id,
    coalesce(nullif(item->>'planType', ''), 'Nao informado'),
    coalesce((item->>'installmentsCount')::integer, 0),
    coalesce((item->>'totalAmountCents')::bigint, 0)
  from jsonb_array_elements(coalesce(p_analysis->'totalsByPlan', '[]'::jsonb)) item;

  select
    coalesce(nullif(mi.final_amount_cents, 0), cbm.installment_amount_cents, 0)::bigint,
    mi.paid_amount_cents,
    nullif(trim(coalesce(mi.payment_description, mi.situation)), '')
  into v_target_amount, v_target_paid, v_payment_description
  from public.campaign_batch_members cbm
  left join lateral (
    select *
    from public.member_installments mi2
    where mi2.campaign_batch_member_id = cbm.id
      and trim(mi2.cod_parcela) = trim(cbm.target_installment_id)
    order by mi2.updated_at desc, mi2.created_at desc, mi2.id desc
    limit 1
  ) mi on true
  where cbm.id = p_campaign_batch_member_id;

  v_explicit_paid := v_target_paid is not null
    and v_payment_description is not null
    and upper(v_payment_description) <> 'ABERTO';
  v_open_amount := case
    when v_explicit_paid then greatest(v_target_amount - v_target_paid, 0)
    else v_target_amount
  end;

  update public.campaign_batch_members
  set processing_status = 'completed',
      payment_status = case when v_explicit_paid then 'paid' else 'unpaid' end,
      payment_status_source = case when v_explicit_paid then 'erp_explicit' else 'erp_open_invoice' end,
      installment_amount_cents = v_target_amount,
      payment_amount_cents = case when v_explicit_paid then coalesce(v_target_paid, 0) else 0 end,
      total_pending_amount_cents = v_open_amount,
      installments_count = v_count,
      last_checked_at = now(),
      last_error = null,
      next_retry_at = null,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null,
      updated_at = now()
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id, batch_id, campaign_batch_member_id, request_status,
    http_status, duration_ms, attempt_number, consulted_at
  ) values (
    v_campaign_id, v_batch_id, p_campaign_batch_member_id, 'success',
    p_http_status, p_duration_ms, greatest(v_attempt, 1), now()
  );

  if p_recalculate then
    perform public.recalculate_batch_totals(v_batch_id);
  end if;
end;
$$;

revoke all on function public.persist_member_processing_success(uuid, integer, integer, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.persist_member_processing_success(uuid, integer, integer, jsonb, boolean)
  to service_role;

-- Reforça a persistência em onda sem depender do paymentStatus calculado em
-- uma etapa intermediária. A evidência final vem da target já persistida.
create or replace function public.persist_processing_wave_v1(
  p_job_id uuid,
  p_batch_id uuid,
  p_worker_id uuid,
  p_wave_id uuid,
  p_results jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_summary jsonb;
  v_normalized_results jsonb;
begin
  select coalesce(
    jsonb_agg(
      case
        when result_item->>'resultType' = 'success'
          and result_item->'analysis'->>'paymentStatus' = 'paid'
          and not exists (
            select 1
            from jsonb_array_elements(coalesce(result_item->'analysis'->'installments', '[]'::jsonb)) installment
            where trim(installment->>'installmentCode') = trim(
              coalesce((
                select cbm.target_installment_id
                from public.campaign_batch_members cbm
                where cbm.id = (result_item->>'campaignBatchMemberId')::uuid
              ), '')
            )
              and nullif(trim(installment->>'paidAmountCents'), '') is not null
              and nullif(trim(coalesce(installment->>'paymentDescription', installment->>'situation')), '') is not null
              and upper(trim(coalesce(installment->>'paymentDescription', installment->>'situation'))) <> 'ABERTO'
          )
        then jsonb_set(
          jsonb_set(
            jsonb_set(result_item, '{analysis,paymentStatus}', '"unpaid"'::jsonb, true),
            '{analysis,paymentStatusSource}', '"erp_open_invoice"'::jsonb, true
          ),
          '{nextCheckAt}', to_jsonb((now() + interval '55 minutes')::text), true
        )
        else result_item
      end
      order by ordinal
    ),
    '[]'::jsonb
  )
  into v_normalized_results
  from jsonb_array_elements(coalesce(p_results, '[]'::jsonb))
       with ordinality as entries(result_item, ordinal);

  v_summary := public.persist_processing_wave_v1_legacy(
    p_job_id, p_batch_id, p_worker_id, p_wave_id, v_normalized_results
  );

  with success_items as (
    select
      (item->>'campaignBatchMemberId')::uuid as campaign_batch_member_id,
      item->'analysis' as analysis
    from jsonb_array_elements(v_normalized_results) item
    where item->>'resultType' = 'success'
  ), installment_values as (
    select
      success_items.campaign_batch_member_id,
      installment->>'installmentCode' as installment_code,
      case
        when nullif(installment->>'paidAmountCents', '') is not null
        then (installment->>'paidAmountCents')::bigint
        else null
      end as paid_amount_cents,
      nullif(trim(coalesce(installment->>'paymentDescription', installment->>'situation')), '')
        as payment_description
    from success_items
    cross join lateral jsonb_array_elements(coalesce(success_items.analysis->'installments', '[]'::jsonb)) installment
  )
  update public.member_installments persisted
  set paid_amount_cents = iv.paid_amount_cents,
      payment_description = iv.payment_description,
      situation = iv.payment_description,
      updated_at = now()
  from installment_values iv
  where persisted.campaign_batch_member_id = iv.campaign_batch_member_id
    and trim(persisted.cod_parcela) = trim(iv.installment_code);

  with success_members as (
    select distinct (item->>'campaignBatchMemberId')::uuid as campaign_batch_member_id
    from jsonb_array_elements(v_normalized_results) item
    where item->>'resultType' = 'success'
  ), target_values as (
    select
      truth.campaign_batch_member_id as id,
      truth.target_amount_cents,
      truth.target_paid_amount_cents,
      truth.is_explicit_paid,
      truth.target_open_amount_cents
    from public.target_installment_payment_v1 truth
    join success_members sm
      on sm.campaign_batch_member_id = truth.campaign_batch_member_id
  )
  update public.campaign_batch_members cbm
  set payment_status = case when tv.is_explicit_paid then 'paid' else 'unpaid' end,
      payment_status_source = case when tv.is_explicit_paid then 'erp_explicit' else 'erp_open_invoice' end,
      installment_amount_cents = tv.target_amount_cents,
      total_pending_amount_cents = tv.target_open_amount_cents,
      payment_amount_cents = case when tv.is_explicit_paid then coalesce(tv.target_paid_amount_cents, 0) else 0 end,
      updated_at = now()
  from target_values tv
  where cbm.id = tv.id;

  perform public.recalculate_batch_totals(p_batch_id);
  return v_summary;
end;
$$;

revoke all on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  to service_role;

create or replace function public.recalculate_batch_totals(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.campaign_batches cb
  set total_records = metrics.total_records,
      processed_records = metrics.completed_records,
      paid_records = metrics.paid_records,
      unpaid_records = metrics.unpaid_records,
      error_records = metrics.error_records,
      total_pending_amount_cents = metrics.total_pending_amount_cents,
      status = case
        when metrics.processing_records > 0 then 'processando'
        when metrics.pending_records > 0 then 'aguardando'
        when metrics.error_records > 0 then 'concluido_com_erros'
        when metrics.total_records > 0 and metrics.completed_records = metrics.total_records then 'concluido'
        else 'aguardando'
      end,
      updated_at = now()
  from (
    select
      count(*)::integer as total_records,
      count(*) filter (where truth.processing_status in ('pending', 'pendente', 'aguardando', 'retrying'))::integer as pending_records,
      count(*) filter (where truth.processing_status = 'processing')::integer as processing_records,
      count(*) filter (where truth.processing_status = 'completed')::integer as completed_records,
      count(*) filter (where truth.processing_status = 'error')::integer as error_records,
      count(*) filter (where truth.processing_status = 'completed' and truth.is_explicit_paid)::integer as paid_records,
      count(*) filter (where truth.processing_status = 'completed' and not truth.is_explicit_paid)::integer as unpaid_records,
      coalesce(sum(truth.target_open_amount_cents) filter (
        where truth.processing_status = 'completed'
      ), 0)::bigint as total_pending_amount_cents
    from public.target_installment_payment_v1 truth
    where truth.batch_id = p_batch_id
  ) metrics
  where cb.id = p_batch_id;
end;
$$;

create or replace function public.get_campaign_metrics(p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with campaign_exists as (
    select 1 from public.campaigns c
    where c.id = p_campaign_id and c.deleted_at is null
  ), member_metrics as (
    select
      count(*)::integer as total,
      count(*) filter (where processing_status in ('pending', 'pendente', 'aguardando', 'retrying'))::integer as pending,
      count(*) filter (where processing_status = 'processing')::integer as processing,
      count(*) filter (where processing_status = 'completed')::integer as completed,
      count(*) filter (where processing_status = 'error')::integer as errored,
      count(*) filter (where processing_status = 'completed' and is_explicit_paid)::integer as paid,
      count(*) filter (where processing_status = 'completed' and not is_explicit_paid)::integer as unpaid,
      coalesce(sum(target_open_amount_cents) filter (where processing_status = 'completed'), 0)::bigint as pending_amount
    from public.target_installment_payment_v1
    where campaign_id = p_campaign_id
  ), batch_metrics as (
    select count(*)::integer as total_batches
    from public.campaign_batches
    where campaign_id = p_campaign_id and deleted_at is null
  ), job_metrics as (
    select
      count(*) filter (where status = 'queued')::integer as queued_jobs,
      count(*) filter (where status = 'running')::integer as running_jobs,
      count(*) filter (where status in ('queued', 'running'))::integer as active_jobs,
      (array_agg(status order by created_at desc))[1] as latest_job_status,
      max(last_heartbeat_at) as latest_heartbeat_at,
      max(lease_expires_at) as lease_expires_at
    from public.processing_jobs
    where campaign_id = p_campaign_id
  )
  select case when exists(select 1 from campaign_exists) then
    jsonb_build_object(
      'campaignId', p_campaign_id,
      'totalBatches', b.total_batches,
      'total', m.total,
      'pending', m.pending,
      'processing', m.processing,
      'completed', m.completed,
      'errored', m.errored,
      'paid', m.paid,
      'unpaid', m.unpaid,
      'remaining', m.pending + m.processing,
      'progressPercentage', case when m.total = 0 then 0 else round(((m.completed + m.errored)::numeric / m.total) * 100, 2) end,
      'totalPendingAmountCents', m.pending_amount,
      'queuedJobs', j.queued_jobs,
      'runningJobs', j.running_jobs,
      'activeJobs', j.active_jobs,
      'latestJobStatus', j.latest_job_status,
      'latestHeartbeatAt', j.latest_heartbeat_at,
      'leaseExpiresAt', j.lease_expires_at,
      'calculatedStatus', case
        when j.running_jobs > 0 then 'processando'
        when j.queued_jobs > 0 then 'fila'
        when m.processing > 0 then 'processando'
        when m.pending > 0 then 'aguardando'
        when m.total > 0 and m.errored > 0 and m.completed + m.errored = m.total then 'concluido_com_erros'
        when m.total > 0 and m.completed = m.total then 'concluido'
        else 'aguardando'
      end
    ) else null end
  from member_metrics m cross join batch_metrics b cross join job_metrics j;
$$;

create or replace function public.get_batch_metrics(p_batch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with batch_exists as (
    select campaign_id from public.campaign_batches
    where id = p_batch_id and deleted_at is null
  ), member_metrics as (
    select
      count(*)::integer as total,
      count(*) filter (where processing_status in ('pending', 'pendente', 'aguardando', 'retrying'))::integer as pending,
      count(*) filter (where processing_status = 'processing')::integer as processing,
      count(*) filter (where processing_status = 'completed')::integer as completed,
      count(*) filter (where processing_status = 'error')::integer as errored,
      count(*) filter (where processing_status = 'completed' and is_explicit_paid)::integer as paid,
      count(*) filter (where processing_status = 'completed' and not is_explicit_paid)::integer as unpaid,
      coalesce(sum(target_open_amount_cents) filter (where processing_status = 'completed'), 0)::bigint as pending_amount
    from public.target_installment_payment_v1
    where batch_id = p_batch_id
  ), job_metrics as (
    select
      count(*) filter (where status = 'queued')::integer as queued_jobs,
      count(*) filter (where status = 'running')::integer as running_jobs,
      count(*) filter (where status in ('queued', 'running'))::integer as active_jobs,
      (array_agg(status order by created_at desc))[1] as latest_job_status
    from public.processing_jobs
    where batch_id = p_batch_id
  )
  select case when exists(select 1 from batch_exists) then
    jsonb_build_object(
      'batchId', p_batch_id,
      'campaignId', (select campaign_id from batch_exists limit 1),
      'total', m.total,
      'pending', m.pending,
      'processing', m.processing,
      'completed', m.completed,
      'errored', m.errored,
      'paid', m.paid,
      'unpaid', m.unpaid,
      'remaining', m.pending + m.processing,
      'progressPercentage', case when m.total = 0 then 0 else round(((m.completed + m.errored)::numeric / m.total) * 100, 2) end,
      'totalPendingAmountCents', m.pending_amount,
      'queuedJobs', j.queued_jobs,
      'runningJobs', j.running_jobs,
      'activeJobs', j.active_jobs,
      'latestJobStatus', j.latest_job_status,
      'calculatedStatus', case
        when j.running_jobs > 0 then 'processando'
        when j.queued_jobs > 0 then 'fila'
        when m.processing > 0 then 'processando'
        when m.pending > 0 then 'aguardando'
        when m.total > 0 and m.errored > 0 and m.completed + m.errored = m.total then 'concluido_com_erros'
        when m.total > 0 and m.completed = m.total then 'concluido'
        else 'aguardando'
      end
    ) else null end
  from member_metrics m cross join job_metrics j;
$$;

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
      and (p_campaign_ids is null or cardinality(p_campaign_ids) = 0 or c.id = any(p_campaign_ids))
  ), selected_batches as (
    select cb.id, cb.campaign_id
    from public.campaign_batches cb
    where cb.deleted_at is null
      and cb.campaign_id in (select id from selected_campaigns)
      and (p_batch_ids is null or cardinality(p_batch_ids) = 0 or cb.id = any(p_batch_ids))
  ), target_rows as (
    select truth.*
    from public.target_installment_payment_v1 truth
    where truth.campaign_id in (select id from selected_campaigns)
      and truth.batch_id in (select id from selected_batches)
  ), campaign_metrics as (
    select count(*)::integer as total_campaigns from selected_campaigns
  ), member_metrics as (
    select
      count(*)::integer as total_cpfs,
      count(distinct member_id)::integer as unique_cpfs,
      count(*) filter (where processing_status = 'completed' and is_explicit_paid)::integer as paid,
      count(*) filter (where processing_status = 'completed' and not is_explicit_paid)::integer as unpaid,
      count(*) filter (where processing_status = 'error')::integer as errored,
      coalesce(sum(case when processing_status = 'completed' and is_explicit_paid then coalesce(target_paid_amount_cents, 0) else 0 end), 0)::bigint as paid_amount,
      coalesce(sum(target_open_amount_cents) filter (where processing_status = 'completed'), 0)::bigint as pending_amount,
      coalesce(sum(target_amount_cents), 0)::bigint as total_amount
    from target_rows
  ), job_metrics as (
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
    'utilizationPercentage', case when m.paid + m.unpaid = 0 then 0 else round((m.paid::numeric / (m.paid + m.unpaid)) * 100, 2) end,
    'totalPendingAmountCents', m.pending_amount,
    'totalPaidAmountCents', m.paid_amount,
    'totalBatchAmountCents', m.total_amount
  )
  from campaign_metrics c cross join member_metrics m cross join job_metrics j;
$$;

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
    join public.campaign_batches cb on cb.id = truth.batch_id and cb.deleted_at is null
    join public.campaigns c on c.id = truth.campaign_id and c.deleted_at is null
    where truth.processing_status = 'completed'
      and truth.is_explicit_paid
      and (p_campaign_ids is null or cardinality(p_campaign_ids) = 0 or truth.campaign_id = any(p_campaign_ids))
      and (p_batch_ids is null or cardinality(p_batch_ids) = 0 or truth.batch_id = any(p_batch_ids))
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
  join public.campaign_batches cb on cb.id = truth.batch_id and cb.deleted_at is null
  join public.campaigns c on c.id = truth.campaign_id and c.deleted_at is null
  where truth.processing_status = 'completed'
    and truth.is_explicit_paid
    and upper(truth.payment_description) like '%PIX%'
    and (p_campaign_ids is null or cardinality(p_campaign_ids) = 0 or truth.campaign_id = any(p_campaign_ids))
    and (p_batch_ids is null or cardinality(p_batch_ids) = 0 or truth.batch_id = any(p_batch_ids));
$$;

revoke all on function public.recalculate_batch_totals(uuid) from public, anon, authenticated;
revoke all on function public.get_campaign_metrics(uuid) from public, anon, authenticated;
revoke all on function public.get_batch_metrics(uuid) from public, anon, authenticated;
revoke all on function public.get_dashboard_metrics(uuid[], uuid[]) from public, anon, authenticated;
revoke all on function public.get_dashboard_receipt_status_metrics(uuid[], uuid[]) from public, anon, authenticated;
revoke all on function public.get_dashboard_pix_paid_metrics(uuid[], uuid[]) from public, anon, authenticated;

grant execute on function public.recalculate_batch_totals(uuid) to service_role;
grant execute on function public.get_campaign_metrics(uuid) to service_role;
grant execute on function public.get_batch_metrics(uuid) to service_role;
grant execute on function public.get_dashboard_metrics(uuid[], uuid[]) to service_role;
grant execute on function public.get_dashboard_receipt_status_metrics(uuid[], uuid[]) to service_role;
grant execute on function public.get_dashboard_pix_paid_metrics(uuid[], uuid[]) to service_role;
