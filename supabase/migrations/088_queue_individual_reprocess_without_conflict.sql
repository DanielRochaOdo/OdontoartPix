-- Reprocessamentos individuais do mesmo lote nao devem disputar um unico job
-- nem devolver 409 ao usuario. Solicitudes adicionais aguardam em fila e sao
-- promovidas automaticamente quando o job individual anterior termina.

create table if not exists public.member_reprocess_waitlist (
  id uuid primary key default gen_random_uuid(),
  campaign_batch_member_id uuid not null references public.campaign_batch_members(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  batch_id uuid not null references public.campaign_batches(id) on delete cascade,
  requested_by uuid not null,
  status text not null default 'queued' check (status in ('queued', 'dispatched', 'fulfilled', 'cancelled')),
  processing_job_id uuid references public.processing_jobs(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists uq_member_reprocess_waitlist_open_member
  on public.member_reprocess_waitlist(campaign_batch_member_id)
  where status = 'queued';

create index if not exists idx_member_reprocess_waitlist_batch_queue
  on public.member_reprocess_waitlist(batch_id, created_at)
  where status = 'queued';

alter table public.member_reprocess_waitlist enable row level security;
revoke all on table public.member_reprocess_waitlist from public, anon, authenticated;
grant select, insert, update, delete on table public.member_reprocess_waitlist to service_role;

create or replace function public.promote_next_member_reprocess_waiting_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wait public.member_reprocess_waitlist;
  v_job_id uuid;
  v_now timestamptz := timezone('utc', now());
begin
  if new.processing_origin <> 'manual'
     or new.processing_scope <> 'member'
     or new.status not in ('completed', 'failed', 'cancelled')
     or old.status = new.status then
    return new;
  end if;

  select * into v_wait
    from public.member_reprocess_waitlist wait
   where wait.batch_id = new.batch_id
     and wait.status = 'queued'
   order by wait.created_at asc, wait.id asc
   for update skip locked
   limit 1;

  if v_wait.id is null then
    return new;
  end if;

  -- Se um processamento mais amplo ja tornou o associado pago, o pedido nao
  -- precisa gerar nova consulta. Marca e tenta o proximo em outra transicao.
  if exists (
    select 1
      from public.campaign_batch_members cbm
     where cbm.id = v_wait.campaign_batch_member_id
       and cbm.payment_status = 'paid'
  ) then
    update public.member_reprocess_waitlist
       set status = 'fulfilled', updated_at = v_now
     where id = v_wait.id;
    return new;
  end if;

  insert into public.processing_jobs(
    campaign_id, batch_id, status, total_items, processed_items, success_items,
    error_items, include_errors, processing_origin, processing_scope,
    processing_priority, target_member_link_id, requested_by, next_run_at
  ) values (
    v_wait.campaign_id, v_wait.batch_id, 'queued', 1, 0, 0, 0,
    false, 'manual', 'member', 40, v_wait.campaign_batch_member_id,
    v_wait.requested_by, v_now
  )
  returning id into v_job_id;

  update public.member_reprocess_waitlist
     set status = 'dispatched', processing_job_id = v_job_id, updated_at = v_now
   where id = v_wait.id;

  return new;
end;
$$;

drop trigger if exists trg_promote_next_member_reprocess_waiting on public.processing_jobs;
create trigger trg_promote_next_member_reprocess_waiting
after update of status
on public.processing_jobs
for each row
execute function public.promote_next_member_reprocess_waiting_v1();

-- Se uma campanha/lote/dashboard processar um associado que estava aguardando
-- prioridade 4, a solicitacao individual ja foi atendida e nao deve duplicar.
create or replace function public.fulfill_waiting_member_reprocess_on_claim_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.processing_status = 'processing'
     and old.processing_status is distinct from 'processing' then
    update public.member_reprocess_waitlist
       set status = 'fulfilled', updated_at = timezone('utc', now())
     where campaign_batch_member_id = new.id
       and status = 'queued';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_fulfill_waiting_member_reprocess_on_claim on public.campaign_batch_members;
create trigger trg_fulfill_waiting_member_reprocess_on_claim
after update of processing_status
on public.campaign_batch_members
for each row
execute function public.fulfill_waiting_member_reprocess_on_claim_v1();

create or replace function public.request_member_reprocess_v6(
  p_member_link_id uuid,
  p_requested_by uuid
)
returns table (
  mode text,
  job_id uuid,
  processing_priority integer,
  processing_scope text,
  batch_id uuid,
  campaign_id uuid,
  target_installment_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result record;
  v_member public.campaign_batch_members;
  v_existing_job public.processing_jobs;
  v_wait_id uuid;
  v_now timestamptz := timezone('utc', now());
begin
  -- Primeiro usa toda a logica corrigida da v5. O unico caso que a v5 recusa
  -- e outro job individual diferente ocupando o mesmo lote.
  begin
    select * into v_result
      from public.request_member_reprocess_v5(p_member_link_id, p_requested_by)
      limit 1;

    return query select
      v_result.mode::text,
      v_result.job_id::uuid,
      v_result.processing_priority::integer,
      v_result.processing_scope::text,
      v_result.batch_id::uuid,
      v_result.campaign_id::uuid,
      v_result.target_installment_id::text;
    return;
  exception
    when lock_not_available then
      null;
  end;

  select * into v_member
    from public.campaign_batch_members cbm
   where cbm.id = p_member_link_id
     and cbm.deleted_at is null
   for update;

  if v_member.id is null then
    raise exception using errcode = 'P0002', message = 'member_link_not_found';
  end if;
  if v_member.payment_status = 'paid' then
    return query select 'already_paid'::text, null::uuid, 0, 'member'::text,
      v_member.batch_id, v_member.campaign_id, v_member.target_installment_id;
    return;
  end if;

  select * into v_existing_job
    from public.processing_jobs pj
   where pj.batch_id = v_member.batch_id
     and pj.processing_origin = 'manual'
     and pj.processing_scope = 'member'
     and pj.status in ('queued', 'running', 'deferred')
   order by pj.created_at asc
   limit 1;

  if v_existing_job.id is null then
    -- O conflito desapareceu entre a tentativa e este fallback; reutiliza v5.
    return query
      select * from public.request_member_reprocess_v5(p_member_link_id, p_requested_by);
    return;
  end if;

  -- A transacao interna da v5 que levantou 55P03 foi revertida. Agora torna o
  -- associado pending e o registra explicitamente na espera P4.
  update public.campaign_batch_members
     set processing_status = 'pending',
         processing_attempts = 0,
         processing_error_code = null,
         error_reprocess_requested_at = null,
         next_retry_at = null,
         next_check_at = null,
         last_error = null,
         processing_owner = null,
         processing_started_at = null,
         processing_heartbeat_at = null,
         claim_token = null,
         updated_at = v_now
   where id = v_member.id;

  insert into public.member_reprocess_waitlist(
    campaign_batch_member_id, campaign_id, batch_id, requested_by, status
  ) values (
    v_member.id, v_member.campaign_id, v_member.batch_id, p_requested_by, 'queued'
  )
  on conflict (campaign_batch_member_id) where status = 'queued'
  do update set requested_by = excluded.requested_by, updated_at = v_now
  returning id into v_wait_id;

  return query select 'waiting_member_job'::text, v_existing_job.id, 40, 'member'::text,
    v_member.batch_id, v_member.campaign_id, v_member.target_installment_id;
end;
$$;

revoke all on function public.request_member_reprocess_v6(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_member_reprocess_v6(uuid, uuid) to service_role;
