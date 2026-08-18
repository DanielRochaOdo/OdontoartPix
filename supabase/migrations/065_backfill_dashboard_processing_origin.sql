-- Jobs que ja pertenciam a uma onda do dashboard antes da separacao devem
-- continuar isolados da fila manual.
update public.processing_jobs pj
   set processing_origin = 'dashboard'
 where exists (
   select 1
     from public.general_sync_run_batches grb
     join public.general_sync_runs gsr on gsr.id = grb.run_id
    where (grb.processing_job_id = pj.id or grb.waiting_job_id = pj.id)
      and gsr.status in ('queued', 'running', 'paused', 'cancelling')
 );
