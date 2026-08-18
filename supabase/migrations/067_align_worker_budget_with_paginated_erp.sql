-- O ciclo precisa comportar a janela completa de consulta paginada do ERP.
-- Sem isso o worker encerra o ciclo antes de reivindicar qualquer job.

update public.processing_settings
   set processing_worker_cycle_budget_ms = greatest(coalesce(processing_worker_cycle_budget_ms, 0), 110000),
       updated_at = timezone('utc', now())
 where settings_key = 'default';
