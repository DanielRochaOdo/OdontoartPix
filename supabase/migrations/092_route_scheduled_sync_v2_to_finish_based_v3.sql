-- Compatibilidade: qualquer codigo ainda chamando v2 recebe a regra v3,
-- baseada no termino da ultima onda geral de qualquer origem.
-- Se a janela venceu mas nao ha nenhum lote elegivel, avanca next_run_at pelo
-- intervalo configurado para nao acordar novos runners GitHub a cada lease.

create or replace function public.create_scheduled_general_sync_run_v2(
  p_request_key text,
  p_requested_by uuid,
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns public.general_sync_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.general_sync_runs;
  v_due boolean := false;
begin
  select coalesce(next_run_at <= timezone('utc', now()), false)
    into v_due
    from public.processing_scheduler_state
   where settings_key = 'default';

  v_run := public.create_scheduled_general_sync_run_v3(
    p_request_key,
    p_requested_by,
    p_stale_seconds,
    p_max_attempts,
    p_max_stale_reclaims
  );

  if v_run.id is null and v_due then
    perform public.recalculate_processing_next_run_v1(timezone('utc', now()), null);
  end if;

  return v_run;
end;
$$;

revoke all on function public.create_scheduled_general_sync_run_v2(text, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_scheduled_general_sync_run_v2(text, uuid, integer, integer, integer)
  to service_role;
