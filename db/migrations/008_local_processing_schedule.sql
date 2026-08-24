create or replace function recalculate_local_processing_next_run_v1(
  p_finished_at timestamptz default null
)
returns timestamptz
language plpgsql
as $$
declare
  v_interval integer := 60;
  v_base timestamptz;
  v_next timestamptz;
begin
  select coalesce(scheduled_interval_minutes, 60)
    into v_interval
    from processing_settings
   where settings_key = 'default';

  if v_interval not in (1, 5, 30, 60, 120) then
    v_interval := 60;
  end if;

  v_base := p_finished_at;

  if v_base is null then
    select finished_at
      into v_base
      from general_sync_runs
     where finished_at is not null
     order by finished_at desc
     limit 1;
  end if;

  v_next := coalesce(v_base, now()) + make_interval(mins => v_interval);

  insert into processing_scheduler_state (
    settings_key,
    next_run_at,
    updated_at
  ) values (
    'default',
    v_next,
    now()
  )
  on conflict (settings_key) do update
    set next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at;

  return v_next;
end;
$$;

create or replace function schedule_local_after_general_sync_finish_v1()
returns trigger
language plpgsql
as $$
begin
  if new.finished_at is not null
     and new.status in ('completed', 'completed_with_errors', 'failed', 'cancelled')
     and (
       old.finished_at is distinct from new.finished_at
       or old.status is distinct from new.status
     ) then
    perform recalculate_local_processing_next_run_v1(new.finished_at);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_local_schedule_after_general_sync_finish
  on general_sync_runs;

create trigger trg_local_schedule_after_general_sync_finish
after update of status, finished_at
on general_sync_runs
for each row
execute function schedule_local_after_general_sync_finish_v1();

create or replace function reset_local_processing_schedule_on_interval_change_v1()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT'
     or old.scheduled_interval_minutes is distinct from new.scheduled_interval_minutes then
    perform recalculate_local_processing_next_run_v1(null);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_local_processing_schedule_interval_change
  on processing_settings;

create trigger trg_local_processing_schedule_interval_change
after insert or update of scheduled_interval_minutes
on processing_settings
for each row
when (new.settings_key = 'default')
execute function reset_local_processing_schedule_on_interval_change_v1();

select recalculate_local_processing_next_run_v1(null);

insert into schema_migrations(version, name)
values (8, 'local_processing_schedule')
on conflict (version) do nothing;
