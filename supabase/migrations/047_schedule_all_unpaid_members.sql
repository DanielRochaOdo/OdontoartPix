-- A leitura agendada deve contemplar toda fatura nao paga.
-- next_check_at continua sendo mantido para exibicao e auditoria, mas nao
-- bloqueia a selecao da proxima onda agendada.

create or replace function public.list_scheduled_recheck_eligible_batches_v1(
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns table (
  batch_id uuid,
  campaign_id uuid,
  batch_name text,
  campaign_name text,
  eligible_count bigint,
  technical_retry_count bigint,
  normal_recheck_count bigint,
  stale_count bigint,
  excluded_error_count bigint,
  has_active_job boolean
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    cb.id,
    cb.campaign_id,
    cb.name,
    c.name,
    counts.eligible_count,
    counts.technical_retry_count,
    counts.normal_recheck_count,
    counts.stale_count,
    counts.excluded_error_count,
    exists (
      select 1
      from public.processing_jobs active_job
      where active_job.batch_id = cb.id
        and active_job.status in ('queued', 'running', 'paused')
    )
  from public.campaign_batches cb
  join public.campaigns c on c.id = cb.campaign_id
  cross join lateral (
    select
      count(*) filter (where cbm.processing_status <> 'processing')::bigint as eligible_count,
      count(*) filter (where cbm.processing_status in ('retrying', 'error'))::bigint as technical_retry_count,
      count(*) filter (where cbm.processing_status <> 'processing' and cbm.processing_status not in ('retrying', 'error'))::bigint as normal_recheck_count,
      count(*) filter (where cbm.processing_status = 'processing')::bigint as stale_count,
      0::bigint as excluded_error_count
    from public.campaign_batch_members cbm
    where cbm.batch_id = cb.id
      and cbm.deleted_at is null
      and cbm.payment_status is distinct from 'paid'
  ) counts
  where cb.deleted_at is null
    and c.deleted_at is null
    and counts.eligible_count > 0;
$$;

revoke all on function public.list_scheduled_recheck_eligible_batches_v1(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.list_scheduled_recheck_eligible_batches_v1(integer, integer, integer)
  to service_role;
