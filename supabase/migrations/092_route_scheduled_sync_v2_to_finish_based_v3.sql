-- Compatibilidade: qualquer codigo ainda chamando v2 recebe a regra v3,
-- baseada no termino da ultima onda geral de qualquer origem.

create or replace function public.create_scheduled_general_sync_run_v2(
  p_request_key text,
  p_requested_by uuid,
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns public.general_sync_runs
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.create_scheduled_general_sync_run_v3(
    p_request_key,
    p_requested_by,
    p_stale_seconds,
    p_max_attempts,
    p_max_stale_reclaims
  );
$$;

revoke all on function public.create_scheduled_general_sync_run_v2(text, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_scheduled_general_sync_run_v2(text, uuid, integer, integer, integer)
  to service_role;
