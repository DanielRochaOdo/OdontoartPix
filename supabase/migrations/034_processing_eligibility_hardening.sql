alter table if exists public.campaign_batch_members
  add column if not exists next_check_at timestamptz,
  add column if not exists payment_status_source text,
  add column if not exists last_erp_status_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists error_reprocess_requested_at timestamptz,
  add column if not exists stale_reclaim_count integer not null default 0,
  add column if not exists claim_token uuid,
  add column if not exists payment_method text,
  add column if not exists payment_date timestamptz,
  add column if not exists payment_amount_cents bigint;

-- stale_reclaim_count is cumulative since the last successful financial
-- completion (or payment). It is not reset by a normal retry, so repeated
-- stale-worker recoveries are bounded across the processing lifecycle.

create index if not exists idx_cbm_eligible_processing
  on public.campaign_batch_members (batch_id, processing_status, next_check_at, next_retry_at, id)
  where deleted_at is null and payment_status is distinct from 'paid';

create or replace function public.invalidate_paid_claim_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.payment_status = 'paid' then
    new.processing_status := 'completed';
    new.next_retry_at := null;
    new.next_check_at := null;
    new.error_reprocess_requested_at := null;
    new.last_error := null;
    new.processing_attempts := 0;
    new.stale_reclaim_count := 0;
    new.processing_owner := null;
    new.processing_started_at := null;
    new.processing_heartbeat_at := null;
    new.claim_token := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_invalidate_paid_claim_v2 on public.campaign_batch_members;
create trigger trg_invalidate_paid_claim_v2
before insert or update of payment_status on public.campaign_batch_members
for each row execute function public.invalidate_paid_claim_v2();

-- Compatibility wrapper: old workers receive the hardened claim rule during
-- a coordinated drain, but legacy persistence is not token-safe.
drop function if exists public.claim_batch_members(uuid, uuid, integer, boolean, integer);
drop function if exists public.claim_batch_members(uuid, uuid, integer, boolean, integer, integer);
drop function if exists public.claim_batch_members(uuid, uuid, integer, boolean, integer, integer, integer);
drop function if exists public.claim_batch_members_v2(uuid, uuid, integer, boolean, integer);
drop function if exists public.claim_batch_members_v2(uuid, uuid, integer, boolean, integer, integer);
drop function if exists public.claim_batch_members_v2(uuid, uuid, integer, boolean, integer, integer, integer);
drop function if exists public.persist_member_processing_success_v2(uuid, uuid, uuid, integer, integer, jsonb, timestamptz);
drop function if exists public.persist_member_processing_error_v2(uuid, uuid, uuid, text, text, integer, integer);
drop function if exists public.persist_member_processing_retry_v2(uuid, uuid, uuid, text, text, integer, integer, timestamptz);

create or replace function public.claim_batch_members_v2(
  p_batch_id uuid,
  p_worker_id uuid,
  p_limit integer,
  p_include_errors boolean default false,
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns setof public.campaign_batch_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_batch_id is null or p_worker_id is null or p_limit is null or p_limit <= 0 then
    raise exception using errcode = '22023', message = 'invalid_claim_arguments';
  end if;

  update public.campaign_batch_members
  set processing_status = 'error',
      last_error = 'Limite de recuperacoes de processamento travado atingido.',
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null,
      error_reprocess_requested_at = null,
      updated_at = now()
  where batch_id = p_batch_id
    and deleted_at is null
    and payment_status is distinct from 'paid'
    and processing_status = 'processing'
    and stale_reclaim_count >= greatest(p_max_stale_reclaims, 1)
    and (
      (processing_heartbeat_at is null and processing_started_at is null)
      or coalesce(processing_heartbeat_at, processing_started_at, updated_at, created_at) < now() - make_interval(secs => greatest(p_stale_seconds, 30))
    );

  return query
  with selected as (
    select cbm.id,
           cbm.processing_status,
           cbm.processing_heartbeat_at,
           cbm.processing_started_at
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and cbm.deleted_at is null
      and cbm.payment_status is distinct from 'paid'
      and (
        (
          cbm.processing_status in ('pending', 'pendente', 'aguardando')
          and (cbm.next_check_at is null or cbm.next_check_at <= now())
          and coalesce(cbm.processing_attempts, 0) < greatest(p_max_attempts, 1)
        )
        or (
          cbm.processing_status = 'retrying'
          and coalesce(cbm.next_retry_at, now()) <= now()
          and coalesce(cbm.processing_attempts, 0) < greatest(p_max_attempts, 1)
        )
        or (
          cbm.processing_status = 'completed'
          and cbm.payment_status = 'unpaid'
          and cbm.next_check_at is not null
          and cbm.next_check_at <= now()
        )
        or (
          p_include_errors
          and cbm.processing_status = 'error'
          and cbm.error_reprocess_requested_at is not null
          and cbm.error_reprocess_requested_at <= now()
          and coalesce(cbm.processing_attempts, 0) < greatest(p_max_attempts, 1)
        )
        or (
          cbm.processing_status = 'processing'
          and (
            (cbm.processing_heartbeat_at is null and cbm.processing_started_at is null)
            or coalesce(cbm.processing_heartbeat_at, cbm.processing_started_at, cbm.updated_at, cbm.created_at) < now() - make_interval(secs => greatest(p_stale_seconds, 30))
          )
          and coalesce(cbm.stale_reclaim_count, 0) < greatest(p_max_stale_reclaims, 1)
        )
      )
    order by
      coalesce(cbm.next_retry_at, cbm.next_check_at, cbm.updated_at, cbm.created_at),
      cbm.created_at,
      cbm.id
    for update skip locked
    limit greatest(p_limit, 1)
  )
  update public.campaign_batch_members cbm
  set processing_status = 'processing',
      processing_owner = p_worker_id,
      processing_started_at = now(),
      processing_heartbeat_at = now(),
      processing_attempts = coalesce(cbm.processing_attempts, 0) + 1,
      claim_token = gen_random_uuid(),
      last_attempt_at = now(),
      stale_reclaim_count = case when selected.processing_status = 'processing' then coalesce(cbm.stale_reclaim_count, 0) + 1 else coalesce(cbm.stale_reclaim_count, 0) end,
      error_reprocess_requested_at = null,
      next_retry_at = null,
      last_reclaim_at = case when selected.processing_status = 'processing' then now() else cbm.last_reclaim_at end,
      last_reclaim_reason = case when selected.processing_status = 'processing' then 'stale-heartbeat' else cbm.last_reclaim_reason end
  from selected
  where cbm.id = selected.id
    and cbm.payment_status is distinct from 'paid'
  returning cbm.*;
end;
$$;

revoke all on function public.claim_batch_members_v2(uuid, uuid, integer, boolean, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_batch_members_v2(uuid, uuid, integer, boolean, integer, integer, integer)
  to service_role;

create function public.claim_batch_members(
  p_batch_id uuid,
  p_worker_id uuid,
  p_limit integer,
  p_include_errors boolean default false,
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns setof public.campaign_batch_members
language sql
security definer
set search_path = public, pg_temp
as $$
  select * from public.claim_batch_members_v2(
    p_batch_id, p_worker_id, p_limit, p_include_errors, p_stale_seconds, p_max_attempts, p_max_stale_reclaims
  );
$$;

revoke all on function public.claim_batch_members(uuid, uuid, integer, boolean, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_batch_members(uuid, uuid, integer, boolean, integer, integer, integer)
  to service_role;

create or replace function public.count_claimable_batch_members_v2(
  p_batch_id uuid,
  p_include_errors boolean default false,
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns table (
  claimable_count bigint,
  scheduled_count bigint,
  processing_count bigint,
  next_run_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with eligible as (
    select cbm.*
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and cbm.deleted_at is null
      and cbm.payment_status is distinct from 'paid'
  ), eligible_with_next_run as (
    select eligible.*,
      case
        when processing_status in ('pending', 'pendente', 'aguardando')
          and next_check_at > now()
          and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1)
          then next_check_at
        when processing_status = 'retrying'
          and next_retry_at > now()
          and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1)
          then next_retry_at
        when processing_status = 'completed'
          and payment_status = 'unpaid'
          and next_check_at > now()
          then next_check_at
        when p_include_errors
          and processing_status = 'error'
          and error_reprocess_requested_at > now()
          and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1)
          then error_reprocess_requested_at
        when processing_status = 'processing' then
          case
            when processing_heartbeat_at is null and processing_started_at is null then now()
            else coalesce(processing_heartbeat_at, processing_started_at, updated_at, created_at)
              + make_interval(secs => greatest(p_stale_seconds, 30))
          end
      end as next_run_candidate
    from eligible
  )
  select
    count(*) filter (where
      (processing_status in ('pending', 'pendente', 'aguardando') and (next_check_at is null or next_check_at <= now()) and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1))
      or (processing_status = 'retrying' and coalesce(next_retry_at, now()) <= now() and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1))
      or (processing_status = 'completed' and payment_status = 'unpaid' and next_check_at is not null and next_check_at <= now())
      or (p_include_errors and processing_status = 'error' and error_reprocess_requested_at is not null and error_reprocess_requested_at <= now() and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1))
      or (processing_status = 'processing' and ((processing_heartbeat_at is null and processing_started_at is null) or coalesce(processing_heartbeat_at, processing_started_at, updated_at, created_at) < now() - make_interval(secs => greatest(p_stale_seconds, 30))) and coalesce(stale_reclaim_count, 0) < greatest(p_max_stale_reclaims, 1))
    )::bigint,
    count(*) filter (where
      (processing_status in ('pending', 'pendente', 'aguardando') and next_check_at > now() and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1))
      or (processing_status = 'retrying' and next_retry_at > now() and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1))
      or (processing_status = 'completed' and payment_status = 'unpaid' and next_check_at > now())
      or (p_include_errors and processing_status = 'error' and error_reprocess_requested_at > now() and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1))
    )::bigint,
    count(*) filter (where processing_status = 'processing')::bigint,
    min(next_run_candidate) filter (where next_run_candidate is not null)
  from eligible_with_next_run;
$$;

revoke all on function public.count_claimable_batch_members_v2(uuid, boolean, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.count_claimable_batch_members_v2(uuid, boolean, integer, integer, integer)
  to service_role;

create or replace function public.release_worker_claims_v2(
  p_batch_id uuid,
  p_worker_id uuid,
  p_reason text,
  p_next_retry_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_batch_id is null or p_worker_id is null or p_next_retry_at is null then
    raise exception using errcode = '22023', message = 'invalid_release_arguments';
  end if;

  update public.campaign_batch_members
  set processing_status = case when payment_status = 'paid' then 'completed' else 'retrying' end,
      next_retry_at = case when payment_status = 'paid' then null else p_next_retry_at end,
      next_check_at = case when payment_status = 'paid' then null else next_check_at end,
      last_error = case when payment_status = 'paid' then null else left(p_reason, 1000) end,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null,
      processing_attempts = case when payment_status = 'paid' then 0 else processing_attempts end,
      updated_at = now()
  where batch_id = p_batch_id
    and processing_owner = p_worker_id
    and processing_status = 'processing';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.release_worker_claims_v2(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.release_worker_claims_v2(uuid, uuid, text, timestamptz)
  to service_role;

create or replace function public.persist_member_processing_success_v2(
  p_campaign_batch_member_id uuid,
  p_worker_id uuid,
  p_claim_token uuid,
  p_http_status integer,
  p_duration_ms integer,
  p_analysis jsonb,
  p_next_check_at timestamptz default null,
  p_recalculate boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
  v_batch_id uuid;
  v_attempt integer;
  v_payment_status text;
  v_payment_source text;
  v_total bigint;
  v_count integer;
begin
  select campaign_id, batch_id, processing_attempts
    into v_campaign_id, v_batch_id, v_attempt
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
    and processing_owner = p_worker_id
    and claim_token = p_claim_token
    and processing_status = 'processing'
  for update;

  if not found then
    return false;
  end if;

  v_payment_status := p_analysis->>'paymentStatus';
  v_payment_source := coalesce(p_analysis->>'paymentStatusSource', 'legacy_contract');
  v_total := coalesce((p_analysis->>'totalPendingAmountCents')::bigint, 0);
  v_count := coalesce((p_analysis->>'installmentsCount')::integer, 0);

  if v_payment_status not in ('paid', 'unpaid') then
    raise exception using errcode = '22023', message = 'invalid_payment_status';
  end if;
  if v_payment_source not in ('erp_open_invoice', 'inferred_from_open_invoices_absence', 'legacy_contract', 'erp_explicit', 'manual', 'import') then
    raise exception using errcode = '22023', message = 'invalid_payment_status_source';
  end if;

  delete from public.member_installments
  where campaign_batch_member_id = p_campaign_batch_member_id;

  insert into public.member_installments(
    campaign_batch_member_id, cod_usuario, cod_parcela, due_date_text,
    installment_type, boleto_code, pix_code, card_payment_link, situation,
    base_amount_cents, fine_amount_cents, interest_amount_cents,
    additional_amount_cents, discount_amount_cents, final_amount_cents,
    plan_type, observation
  )
  select
    p_campaign_batch_member_id,
    nullif(item->>'userCode', ''), item->>'installmentCode',
    nullif(item->>'dueDate', ''), nullif(item->>'installmentType', ''),
    nullif(item->>'boletoCode', ''), nullif(item->>'pixCode', ''),
    nullif(item->>'cardPaymentLink', ''), nullif(item->>'situation', ''),
    coalesce((item->>'baseAmountCents')::bigint, 0),
    coalesce((item->>'fineAmountCents')::bigint, 0),
    coalesce((item->>'interestAmountCents')::bigint, 0),
    coalesce((item->>'additionalAmountCents')::bigint, 0),
    coalesce((item->>'discountAmountCents')::bigint, 0),
    coalesce((item->>'finalAmountCents')::bigint, 0),
    coalesce(nullif(item->>'planType', ''), 'Nao informado'),
    nullif(item->>'observation', '')
  from jsonb_array_elements(coalesce(p_analysis->'installments', '[]'::jsonb)) item;

  update public.campaign_batch_members
  set processing_status = 'completed',
      payment_status = v_payment_status,
      payment_status_source = v_payment_source,
      total_pending_amount_cents = case when v_payment_status = 'unpaid' then v_total else 0 end,
      installment_amount_cents = case when v_payment_status = 'unpaid' then v_total else installment_amount_cents end,
      installments_count = v_count,
      processing_attempts = 0,
      stale_reclaim_count = 0,
      last_checked_at = now(),
      last_erp_status_at = now(),
      next_check_at = case when v_payment_status = 'unpaid' then coalesce(p_next_check_at, now() + interval '55 minutes') else null end,
      next_retry_at = null,
      last_error = null,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id, batch_id, campaign_batch_member_id, request_status,
    http_status, duration_ms, attempt_number, consulted_at
  ) values (
    v_campaign_id, v_batch_id, p_campaign_batch_member_id, 'success',
    p_http_status, p_duration_ms, greatest(v_attempt, 1), now()
  );

  if p_recalculate then perform public.recalculate_batch_totals(v_batch_id); end if;
  return true;
end;
$$;

revoke all on function public.persist_member_processing_success_v2(uuid, uuid, uuid, integer, integer, jsonb, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.persist_member_processing_success_v2(uuid, uuid, uuid, integer, integer, jsonb, timestamptz, boolean)
  to service_role;

create or replace function public.persist_member_processing_error_v2(
  p_campaign_batch_member_id uuid,
  p_worker_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_duration_ms integer default null,
  p_recalculate boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
  v_batch_id uuid;
  v_attempt integer;
  v_payment_status text;
begin
  select campaign_id, batch_id, processing_attempts, payment_status
    into v_campaign_id, v_batch_id, v_attempt, v_payment_status
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
    and processing_owner = p_worker_id
    and claim_token = p_claim_token
    and processing_status = 'processing'
  for update;

  if not found then return false; end if;

  update public.campaign_batch_members
  set processing_status = case when v_payment_status = 'paid' then 'completed' else 'error' end,
      last_attempt_at = now(),
      last_error = left(coalesce(p_error_message, p_error_code, 'Falha de processamento.'), 1000),
      next_retry_at = null,
      next_check_at = case when v_payment_status = 'paid' then null else next_check_at end,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id, batch_id, campaign_batch_member_id, request_status,
    http_status, duration_ms, attempt_number, error_code, error_message, consulted_at
  ) values (
    v_campaign_id, v_batch_id, p_campaign_batch_member_id, 'error',
    p_http_status, p_duration_ms, greatest(v_attempt, 1),
    left(p_error_code, 100), left(p_error_message, 1000), now()
  );

  if p_recalculate then perform public.recalculate_batch_totals(v_batch_id); end if;
  return true;
end;
$$;

create or replace function public.persist_member_processing_retry_v2(
  p_campaign_batch_member_id uuid,
  p_worker_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_duration_ms integer default null,
  p_next_retry_at timestamptz default null,
  p_recalculate boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
  v_batch_id uuid;
  v_attempt integer;
  v_payment_status text;
begin
  select campaign_id, batch_id, processing_attempts, payment_status
    into v_campaign_id, v_batch_id, v_attempt, v_payment_status
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
    and processing_owner = p_worker_id
    and claim_token = p_claim_token
    and processing_status = 'processing'
  for update;

  if not found then return false; end if;

  update public.campaign_batch_members
  set processing_status = case when v_payment_status = 'paid' then 'completed' else 'retrying' end,
      last_attempt_at = now(),
      last_error = case when v_payment_status = 'paid' then null else left(coalesce(p_error_message, p_error_code, 'Falha transitória de processamento.'), 1000) end,
      next_retry_at = case when v_payment_status = 'paid' then null else coalesce(p_next_retry_at, now()) end,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id, batch_id, campaign_batch_member_id, request_status,
    http_status, duration_ms, attempt_number, error_code, error_message, consulted_at
  ) values (
    v_campaign_id, v_batch_id, p_campaign_batch_member_id, 'retrying',
    p_http_status, p_duration_ms, greatest(v_attempt, 1),
    left(p_error_code, 100), left(p_error_message, 1000), now()
  );

  if p_recalculate then perform public.recalculate_batch_totals(v_batch_id); end if;
  return true;
end;
$$;

revoke all on function public.persist_member_processing_error_v2(uuid, uuid, uuid, text, text, integer, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.persist_member_processing_retry_v2(uuid, uuid, uuid, text, text, integer, integer, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.persist_member_processing_error_v2(uuid, uuid, uuid, text, text, integer, integer, boolean)
  to service_role;
grant execute on function public.persist_member_processing_retry_v2(uuid, uuid, uuid, text, text, integer, integer, timestamptz, boolean)
  to service_role;

-- Keep legacy persistence safe during a rolling deployment. Legacy workers do
-- not provide a claim token, but they must still preserve a confirmed payment.
create or replace function public.persist_member_processing_error(
  p_campaign_batch_member_id uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_duration_ms integer default null,
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
  v_attempt integer;
  v_payment_status text;
begin
  select campaign_id, batch_id, processing_attempts, payment_status
    into v_campaign_id, v_batch_id, v_attempt, v_payment_status
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_batch_member_not_found';
  end if;

  update public.campaign_batch_members
  set processing_status = case when v_payment_status = 'paid' then 'completed' else 'error' end,
      last_attempt_at = now(),
      last_error = case when v_payment_status = 'paid' then null else left(coalesce(p_error_message, p_error_code, 'Falha de processamento.'), 1000) end,
      next_retry_at = null,
      next_check_at = case when v_payment_status = 'paid' then null else next_check_at end,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id, batch_id, campaign_batch_member_id, request_status,
    http_status, duration_ms, attempt_number, error_code, error_message, consulted_at
  ) values (
    v_campaign_id, v_batch_id, p_campaign_batch_member_id, 'error',
    p_http_status, p_duration_ms, greatest(v_attempt, 1),
    left(p_error_code, 100), left(p_error_message, 1000), now()
  );

  if p_recalculate then perform public.recalculate_batch_totals(v_batch_id); end if;
end;
$$;

create or replace function public.persist_member_processing_retry(
  p_campaign_batch_member_id uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_duration_ms integer default null,
  p_next_retry_at timestamptz default null,
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
  v_attempt integer;
  v_payment_status text;
begin
  select campaign_id, batch_id, processing_attempts, payment_status
    into v_campaign_id, v_batch_id, v_attempt, v_payment_status
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_batch_member_not_found';
  end if;

  update public.campaign_batch_members
  set processing_status = case when v_payment_status = 'paid' then 'completed' else 'retrying' end,
      last_attempt_at = now(),
      last_error = case when v_payment_status = 'paid' then null else left(coalesce(p_error_message, p_error_code, 'Falha transitória de processamento.'), 1000) end,
      next_retry_at = case when v_payment_status = 'paid' then null else coalesce(p_next_retry_at, now()) end,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id, batch_id, campaign_batch_member_id, request_status,
    http_status, duration_ms, attempt_number, error_code, error_message, consulted_at
  ) values (
    v_campaign_id, v_batch_id, p_campaign_batch_member_id, 'retrying',
    p_http_status, p_duration_ms, greatest(v_attempt, 1),
    left(p_error_code, 100), left(p_error_message, 1000), now()
  );

  if p_recalculate then perform public.recalculate_batch_totals(v_batch_id); end if;
end;
$$;
