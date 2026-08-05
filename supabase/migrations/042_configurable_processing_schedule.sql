-- Configuração do intervalo do pulso automático.
-- O GitHub Actions continua executando a cada 30 minutos; esta configuração
-- apenas decide quando uma nova sincronização pode ser iniciada.

alter table public.processing_settings
  add column if not exists scheduled_interval_minutes integer not null default 60;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.processing_settings'::regclass
      and conname = 'processing_settings_scheduled_interval_minutes_check'
  ) then
    alter table public.processing_settings
      add constraint processing_settings_scheduled_interval_minutes_check
      check (scheduled_interval_minutes in (30, 60, 120));
  end if;
end $$;

create table if not exists public.processing_scheduler_state (
  settings_key text primary key default 'default' check (settings_key = 'default'),
  last_checked_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.processing_scheduler_state (settings_key)
values ('default')
on conflict (settings_key) do nothing;

alter table public.processing_scheduler_state enable row level security;

create or replace function public.reset_scheduled_processing_slot_on_config_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.processing_scheduler_state
    set last_checked_at = null,
        updated_at = now()
    where settings_key = 'default';
  elsif old.scheduled_interval_minutes is distinct from new.scheduled_interval_minutes then
    update public.processing_scheduler_state
    set last_checked_at = null,
        updated_at = now()
    where settings_key = 'default';
  end if;
  return new;
end;
$$;

drop trigger if exists processing_settings_reset_scheduler_slot
  on public.processing_settings;
create trigger processing_settings_reset_scheduler_slot
after insert or update of scheduled_interval_minutes
on public.processing_settings
for each row
execute function public.reset_scheduled_processing_slot_on_config_change();

drop function if exists public.claim_scheduled_processing_slot_v1(timestamptz);
create function public.claim_scheduled_processing_slot_v1(
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_interval_minutes integer := 60;
  v_last_checked_at timestamptz;
begin
  select coalesce(scheduled_interval_minutes, 60)
    into v_interval_minutes
  from public.processing_settings
  where settings_key = 'default';

  if v_interval_minutes not in (30, 60, 120) then
    v_interval_minutes := 60;
  end if;

  select last_checked_at
    into v_last_checked_at
  from public.processing_scheduler_state
  where settings_key = 'default'
  for update;

  if v_last_checked_at is not null
     and p_now < v_last_checked_at + make_interval(mins => v_interval_minutes) then
    return false;
  end if;

  update public.processing_scheduler_state
  set last_checked_at = p_now,
      updated_at = now()
  where settings_key = 'default';

  return true;
end;
$$;

revoke all on function public.claim_scheduled_processing_slot_v1(timestamptz) from public;
grant execute on function public.claim_scheduled_processing_slot_v1(timestamptz) to service_role;
