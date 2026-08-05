-- Registra os pulsos reais recebidos pelo endpoint do scheduler.

alter table public.processing_scheduler_state
  add column if not exists last_pulse_started_at timestamptz,
  add column if not exists last_pulse_finished_at timestamptz,
  add column if not exists last_pulse_status text,
  add column if not exists last_pulse_error text;

create or replace function public.record_processing_scheduler_pulse_v1(
  p_started_at timestamptz,
  p_finished_at timestamptz default null,
  p_status text default 'running',
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  update public.processing_scheduler_state
  set last_pulse_started_at = coalesce(p_started_at, now()),
      last_pulse_finished_at = p_finished_at,
      last_pulse_status = left(coalesce(p_status, 'running'), 32),
      last_pulse_error = left(p_error, 1000),
      updated_at = now()
  where settings_key = 'default';
end;
$$;

revoke all on function public.record_processing_scheduler_pulse_v1(timestamptz, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.record_processing_scheduler_pulse_v1(timestamptz, timestamptz, text, text)
  to service_role;
