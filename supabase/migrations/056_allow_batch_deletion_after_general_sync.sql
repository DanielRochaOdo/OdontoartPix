-- Historicos de sincronizacao geral nao devem impedir a exclusao permanente
-- de um lote ja concluido. O historico do lote acompanha a exclusao do lote.

alter table if exists public.general_sync_run_batches
  drop constraint if exists general_sync_run_batches_batch_id_fkey;

alter table if exists public.general_sync_run_batches
  add constraint general_sync_run_batches_batch_id_fkey
  foreign key (batch_id)
  references public.campaign_batches(id)
  on delete cascade;

-- A mesma regra evita que historicos de sincronizacao bloqueiem a exclusao
-- de uma campanha que contenha lotes ja processados.
alter table if exists public.general_sync_run_batches
  drop constraint if exists general_sync_run_batches_campaign_id_fkey;

alter table if exists public.general_sync_run_batches
  add constraint general_sync_run_batches_campaign_id_fkey
  foreign key (campaign_id)
  references public.campaigns(id)
  on delete cascade;
