-- Um job so pode permanecer pausado quando existe uma solicitacao explicita
-- identificada. Qualquer pausa sem essa origem volta automaticamente para a fila.

create or replace function public.normalize_implicit_processing_pause_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'paused'
     and (new.stop_requested_at is null or new.stop_requested_by is null) then
    new.status := 'queued';
    new.stop_requested_at := null;
    new.stop_requested_by := null;
    new.stop_reason := null;
    new.finished_at := null;
    new.next_run_at := coalesce(new.next_run_at, timezone('utc', now()));
    new.updated_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_normalize_implicit_processing_pause on public.processing_jobs;
create trigger trg_normalize_implicit_processing_pause
before insert or update of status, stop_requested_at, stop_requested_by
on public.processing_jobs
for each row
execute function public.normalize_implicit_processing_pause_v1();
