-- O perfil validado em producao deixa de aparecer como Customizado. A
-- migracao apenas classifica a configuracao atual; os valores efetivos nao sao
-- alterados durante o deploy.
update processing_settings
   set preset_key = 'agressivo',
       updated_at = now()
 where settings_key = 'default'
   and coalesce((config ->> 'processing_block_size')::integer, 0) = 60
   and coalesce((config ->> 'processing_concurrency')::integer, 0) = 50
   and coalesce((config ->> 'processing_erp_concurrency')::integer, 0) = 50
   and coalesce((config ->> 'processing_max_buffered_results')::integer, 0) = 60
   and coalesce((config ->> 'processing_productive_delay_ms')::integer, -1) = 0;

-- A partir desta versao, scheduler_enabled e a fonte unica de verdade para o
-- automatico. Ao ativar, a proxima execucao comeca a contar a partir do
-- momento da ativacao e usa scheduled_interval_minutes.
create or replace function set_local_processing_scheduler_enabled_v1(p_enabled boolean)
returns boolean
language plpgsql
as $$
declare
  v_system_user_id uuid;
begin
  select system_user_id
    into v_system_user_id
    from processing_scheduler_state
   where settings_key = 'default'
   for update;

  if v_system_user_id is null then
    raise exception 'LOCAL_PROCESSING_SYSTEM_USER_NOT_CONFIGURED';
  end if;

  if not exists (
    select 1
      from users
     where id = v_system_user_id
       and active = true
       and login_enabled = false
  ) then
    raise exception 'LOCAL_PROCESSING_SYSTEM_USER_INVALID';
  end if;

  update processing_scheduler_state
     set scheduler_enabled = p_enabled,
         updated_at = now()
   where settings_key = 'default';

  if p_enabled then
    perform recalculate_local_processing_next_run_v1(now());
  end if;

  return p_enabled;
end;
$$;

insert into schema_migrations(version, name)
values (17, 'processing_profile_and_scheduler_control')
on conflict (version) do nothing;
