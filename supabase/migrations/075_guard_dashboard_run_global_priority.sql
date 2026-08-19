-- Enquanto uma sincronizacao geral do dashboard estiver ativa, jobs manuais
-- podem ser criados e permanecer queued, mas nao podem ser reivindicados entre
-- dois lotes da mesma onda. Isso preserva a prioridade 1 durante o run inteiro.

create or replace function public.claim_next_processing_job(
  p_worker_id uuid,
  p_lease_seconds integer default 240,
  p_processing_origin text default null
)
returns setof public.processing_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select pj.id
    from public.processing_jobs pj
    where (
      (
        pj.status = 'queued'
        and coalesce(pj.next_run_at, now()) <= now()
      )
      or (
        pj.status = 'running'
        and pj.lease_expires_at is not null
        and pj.lease_expires_at < now()
      )
    )
      and (p_processing_origin is null or pj.processing_origin = p_processing_origin)
      and (
        pj.processing_origin = 'dashboard'
        or not exists (
          select 1
          from public.general_sync_runs gsr
          where gsr.status in ('queued', 'running', 'cancelling')
        )
      )
      and not exists (
        select 1
        from public.processing_jobs higher
        where higher.status = 'queued'
          and coalesce(higher.next_run_at, now()) <= now()
          and higher.processing_priority > pj.processing_priority
      )
      and (
        pj.status = 'running'
        or not exists (
          select 1
          from public.processing_jobs active
          where active.id <> pj.id
            and active.status = 'running'
            and (active.lease_expires_at is null or active.lease_expires_at >= now())
        )
      )
    order by pj.processing_priority desc,
             coalesce(pj.next_run_at, pj.created_at),
             pj.created_at
    for update skip locked
    limit 1
  )
  update public.processing_jobs pj
  set status = 'running',
      locked_by = p_worker_id,
      started_at = coalesce(pj.started_at, now()),
      last_heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
      worker_attempts = coalesce(pj.worker_attempts, 0) + 1,
      updated_at = now(),
      last_error = null
  from candidate
  where pj.id = candidate.id
  returning pj.*;
end;
$$;

revoke all on function public.claim_next_processing_job(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.claim_next_processing_job(uuid, integer, text) to service_role;
