-- Isola a troca de unicidade dos jobs de processamento em uma transacao propria.
--
-- A versao anterior executava este DDL dentro da migration 071 depois de
-- atualizar member_installments. Com workers ativos, uma sessao podia manter
-- RowExclusiveLock em processing_jobs enquanto aguardava member_installments,
-- ao mesmo tempo em que a migration mantinha locks em member_installments e
-- aguardava AccessExclusiveLock para remover o indice antigo. Isso formava um
-- ciclo de deadlock.
--
-- Mantendo esta migration restrita a processing_jobs, qualquer concorrencia
-- vira apenas espera pelo lock da tabela/indice, sem segurar locks nas tabelas
-- financeiras usadas pelo worker.

drop index if exists public.uq_processing_jobs_one_active_per_batch;
drop index if exists public.uq_processing_jobs_one_active_per_origin;

create unique index uq_processing_jobs_one_active_per_origin
  on public.processing_jobs(batch_id, processing_origin)
  where status in ('queued', 'running');
