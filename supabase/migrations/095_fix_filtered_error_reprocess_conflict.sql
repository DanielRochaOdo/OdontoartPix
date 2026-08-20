-- Corrige ambiguidade PL/pgSQL introduzida na 094.
-- request_id e tambem coluna de saida da funcao (RETURNS TABLE), portanto
-- ON CONFLICT (request_id, member_link_id) pode ser interpretado como variavel
-- PL/pgSQL ou coluna da tabela. Usamos a constraint primaria explicitamente.
--
-- A 094 ja pode estar aplicada em producao, entao nao deve ser editada.

do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_old text := 'on conflict (request_id, member_link_id) do nothing';
  v_new text := 'on conflict on constraint filtered_error_reprocess_items_pkey do nothing';
begin
  select to_regprocedure('public.request_filtered_error_reprocess_v1(uuid[],uuid)')::oid
    into v_function_oid;

  if v_function_oid is null then
    raise exception using
      errcode = '42883',
      message = 'request_filtered_error_reprocess_v1_not_found';
  end if;

  select pg_get_functiondef(v_function_oid)
    into v_definition;

  if position(v_old in v_definition) = 0 then
    -- Idempotencia defensiva: se a funcao ja estiver corrigida, nao faz nada.
    if position(v_new in v_definition) > 0 then
      return;
    end if;

    raise exception using
      errcode = 'P0001',
      message = 'request_filtered_error_reprocess_v1_conflict_target_not_found';
  end if;

  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$migration$;

revoke all on function public.request_filtered_error_reprocess_v1(uuid[], uuid)
  from public, anon, authenticated;
grant execute on function public.request_filtered_error_reprocess_v1(uuid[], uuid)
  to service_role;
