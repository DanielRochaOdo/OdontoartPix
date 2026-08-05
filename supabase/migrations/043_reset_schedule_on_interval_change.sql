-- Ao alterar a frequência, o próximo pulso deve avaliar imediatamente a nova configuração.

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
