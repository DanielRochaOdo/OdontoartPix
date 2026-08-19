-- Jobs manuais solicitados durante uma onda geral ficam deferred. Assim eles
-- nao aparecem para o orquestrador do dashboard como jobs queued/running do
-- mesmo lote e nao criam espera circular. Ao finalizar/cancelar o run, voltam
-- automaticamente para queued.

-- Garante a compatibilidade do novo estado antes da primeira gravacao. Se uma
-- versao anterior do schema nao possuir essa constraint, o DROP e inofensivo.
alter table public.processing_jobs
  drop constraint if exists processing_jobs_status_check;
alter table public.processing_jobs
  add constraint processing_jobs_status_check
  check (status in ('queued', 'running', 'deferred', 'completed', 'failed', 'paused', 'cancelled'));

create unique index if not exists uq_processing_jobs_one_open_per_origin
  on public.processing_jobs(batch_id, processing_origin)
  where status in ('queued', 'running', 'deferred');

create or replace function public.defer_manual_processing_during_dashboard_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.processing_origin = 'manual'
     and new.status = 'queued'
     and exists (
       select 1
       from public.general_sync_runs gsr
       where gsr.status in ('queued', 'running', 'cancelling')
     ) then
    new.status := 'deferred';
    new.locked_by := null;
    new.lease_expires_at := null;
    new.updated_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_defer_manual_processing_during_dashboard on public.processing_jobs;
create trigger trg_defer_manual_processing_during_dashboard
before insert or update of status, processing_origin
on public.processing_jobs
for each row
execute function public.defer_manual_processing_during_dashboard_v1();

-- Prioridade cooperativa: ao ceder para o dashboard, um job manual vira
-- deferred enquanto o run geral existir. Em outras preempcoes, volta a queued.
create or replace function public.normalize_prioritized_processing_transition_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'paused' and coalesce(new.stop_reason, '') like 'priority-preempt:%' then
    new.status := case
      when new.processing_origin = 'manual' and exists (
        select 1
        from public.general_sync_runs gsr
        where gsr.status in ('queued', 'running', 'cancelling')
      ) then 'deferred'
      else 'queued'
    end;
    new.stop_requested_at := null;
    new.stop_requested_by := null;
    new.stop_reason := null;
    new.finished_at := null;
    new.next_run_at := timezone('utc', now());
    new.updated_at := timezone('utc', now());
  elsif new.status = 'paused'
        and new.processing_origin = 'dashboard'
        and coalesce(new.stop_reason, '') like 'dashboard-cancel:%' then
    new.status := 'cancelled';
    new.next_run_at := null;
    new.finished_at := coalesce(new.finished_at, timezone('utc', now()));
    new.updated_at := timezone('utc', now());
  end if;

  if new.target_member_link_id is not null
     and new.status = 'queued'
     and coalesce(new.processed_items, 0) >= greatest(coalesce(new.total_items, 1), 1) then
    new.status := 'completed';
    new.next_run_at := null;
    new.finished_at := coalesce(new.finished_at, timezone('utc', now()));
    new.updated_at := timezone('utc', now());
  end if;

  return new;
end;
$$;

-- Mudancas do run geral controlam a barreira de prioridade global.
create or replace function public.manage_dashboard_priority_barrier_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := timezone('utc', now());
begin
  if new.status in ('queued', 'running', 'cancelling') then
    -- O que ainda nao comecou fica deferred.
    update public.processing_jobs
       set status = 'deferred',
           locked_by = null,
           lease_expires_at = null,
           updated_at = v_now
     where processing_origin = 'manual'
       and status = 'queued';

    -- O que ja esta no meio de um bloco recebe preempcao cooperativa. O worker
    -- termina as chamadas em voo; na liberacao o trigger acima vira deferred.
    update public.processing_jobs
       set stop_requested_at = coalesce(stop_requested_at, v_now),
           stop_requested_by = coalesce(new.requested_by, stop_requested_by),
           stop_reason = case
             when stop_requested_at is null then 'priority-preempt:100'
             else stop_reason
           end,
           updated_at = v_now
     where processing_origin = 'manual'
       and status = 'running'
       and stop_requested_at is null;
  elsif new.status in ('completed', 'completed_with_errors', 'failed', 'cancelled')
        and old.status in ('queued', 'running', 'cancelling', 'paused') then
    -- A onda terminou: todas as solicitacoes menores voltam a disputar a fila
    -- pela prioridade campanha(80) > lote(60) > associado(40).
    update public.processing_jobs
       set status = 'queued',
           next_run_at = v_now,
           stop_requested_at = null,
           stop_requested_by = null,
           stop_reason = null,
           finished_at = null,
           updated_at = v_now
     where processing_origin = 'manual'
       and status = 'deferred';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_manage_dashboard_priority_barrier on public.general_sync_runs;
create trigger trg_manage_dashboard_priority_barrier
after insert or update of status
on public.general_sync_runs
for each row
execute function public.manage_dashboard_priority_barrier_v1();

-- Se esta migration entrar enquanto ja existe um run ativo, normaliza jobs
-- manuais queued imediatamente.
update public.processing_jobs
set status = 'deferred',
    locked_by = null,
    lease_expires_at = null,
    updated_at = timezone('utc', now())
where processing_origin = 'manual'
  and status = 'queued'
  and exists (
    select 1 from public.general_sync_runs gsr
    where gsr.status in ('queued', 'running', 'cancelling')
  );
