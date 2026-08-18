-- The ERP pagination can legitimately return more than one page per member.
-- Keep the wave payload guard, but do not reject a complete history merely
-- because it is larger than the old single-page limit of 200 installments.
do $$
declare
  v_definition text;
  v_updated_definition text;
begin
  select pg_get_functiondef(p.oid)
    into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'persist_processing_wave_v1_legacy'
    and pg_get_function_identity_arguments(p.oid) = 'p_job_id uuid, p_batch_id uuid, p_worker_id uuid, p_wave_id uuid, p_results jsonb';

  if v_definition is null then
    raise exception 'persist_processing_wave_v1_legacy nao encontrada';
  end if;

  v_updated_definition := replace(v_definition, '200', '1000');

  if v_updated_definition = v_definition then
    raise exception 'limite de historico da persist_processing_wave_v1_legacy nao localizado';
  end if;

  execute v_updated_definition;
end;
$$;
