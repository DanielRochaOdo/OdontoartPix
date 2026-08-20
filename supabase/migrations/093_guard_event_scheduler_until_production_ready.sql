-- Protecao de cutover: o scheduler orientado a eventos fica instalado, mas
-- desarmado por padrao ate a nova main + novo deploy Vercel estarem validados.
-- Isso evita que a migration 091 acorde um workflow antigo da main durante o
-- intervalo entre db push e merge/deploy.

alter table public.processing_scheduler_state
  add column if not exists scheduler_enabled boolean not null default false;

update public.processing_scheduler_state
   set scheduler_enabled = false,
       updated_at = timezone('utc', now())
 where settings_key = 'default';

create or replace function public.dispatch_due_processing_workflow_guarded_v1()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean := false;
begin
  select coalesce(scheduler_enabled, false)
    into v_enabled
    from public.processing_scheduler_state
   where settings_key = 'default';

  if not v_enabled then
    return false;
  end if;

  return public.dispatch_due_processing_workflow_v1();
end;
$$;

revoke all on function public.dispatch_due_processing_workflow_guarded_v1()
  from public, anon, authenticated;
grant execute on function public.dispatch_due_processing_workflow_guarded_v1()
  to service_role;

-- Substitui o cron criado na 091 pela versao protegida. A migration 093 e
-- aplicada no mesmo db push, antes da proxima janela de um minuto do cron.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid
      from cron.job
     where jobname = 'odontoartpix-event-driven-scheduler'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end $$;

select cron.schedule(
  'odontoartpix-event-driven-scheduler',
  '* * * * *',
  $cron$select public.dispatch_due_processing_workflow_guarded_v1();$cron$
);

create or replace function public.set_processing_scheduler_enabled_v1(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.processing_scheduler_state
     set scheduler_enabled = coalesce(p_enabled, false),
         dispatch_lease_expires_at = null,
         updated_at = timezone('utc', now())
   where settings_key = 'default';

  return coalesce(p_enabled, false);
end;
$$;

revoke all on function public.set_processing_scheduler_enabled_v1(boolean)
  from public, anon, authenticated;
grant execute on function public.set_processing_scheduler_enabled_v1(boolean)
  to service_role;
