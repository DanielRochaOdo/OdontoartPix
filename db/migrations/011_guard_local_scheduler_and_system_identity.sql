alter table processing_scheduler_state
  add column if not exists scheduler_enabled boolean not null default false,
  add column if not exists system_user_id uuid references users(id) on delete set null;

-- Identidade tecnica local. Nao possui login interativo e nao recebe uma senha
-- utilizavel. O id fica no proprio estado do scheduler, evitando segredo ou id
-- hardcoded no worker.
do $$
declare
  v_user_id uuid;
  v_existing_name text;
begin
  select id, name
    into v_user_id, v_existing_name
    from users
   where lower(email) = 'odontoartpix-processing@system.local'
   limit 1;

  if v_user_id is not null and v_existing_name <> 'OdontoartPix Processing Service' then
    raise exception 'PROCESSING_SERVICE_EMAIL_CONFLICT';
  end if;

  if v_user_id is null then
    insert into users (
      name,
      email,
      password_hash,
      role,
      active,
      login_enabled
    ) values (
      'OdontoartPix Processing Service',
      'odontoartpix-processing@system.local',
      'DISABLED:' || encode(gen_random_bytes(32), 'hex'),
      'operador',
      true,
      false
    )
    returning id into v_user_id;
  else
    update users
       set role = 'operador',
           active = true,
           login_enabled = false,
           updated_at = now()
     where id = v_user_id;
  end if;

  update sessions
     set revoked_at = coalesce(revoked_at, now())
   where user_id = v_user_id
     and revoked_at is null;

  update processing_scheduler_state
     set scheduler_enabled = false,
         system_user_id = v_user_id,
         updated_at = now()
   where settings_key = 'default';
end;
$$;

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

  return p_enabled;
end;
$$;

create index if not exists processing_scheduler_enabled_idx
  on processing_scheduler_state(scheduler_enabled, next_run_at)
  where scheduler_enabled = true;

insert into schema_migrations(version, name)
values (11, 'guard_local_scheduler_and_system_identity')
on conflict (version) do nothing;
