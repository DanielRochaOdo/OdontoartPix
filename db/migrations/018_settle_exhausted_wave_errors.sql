-- Registros que ja atingiram o limite de tentativas nao podem ficar fora do
-- fechamento matematico da onda. Assim que o worker assume o job, qualquer
-- item ainda pendente e sem possibilidade de novo claim vira erro terminal da
-- onda e passa a compor processed_items/error_items imediatamente.
--
-- A checagem tambem ocorre no fechamento do job como rede de seguranca para
-- estados legados. A proxima onda automatica continua reabrindo os nao pagos
-- e zerando as tentativas pelo fluxo scheduled_recheck da aplicacao. Portanto
-- este erro e terminal apenas para a onda atual, nunca um bloqueio permanente.

create or replace function settle_exhausted_wave_errors_v1()
returns trigger
language plpgsql
as $$
declare
  exhausted_count integer := 0;
begin
  if new.status in ('running', 'completed')
     and old.status is distinct from new.status
     and new.batch_id is not null then
    with exhausted as (
      update campaign_batch_members
         set processing_status = 'error',
             processing_error_code = coalesce(
               nullif(trim(processing_error_code), ''),
               'PROCESSING_ATTEMPT_LIMIT'
             ),
             last_error = coalesce(
               nullif(trim(last_error), ''),
               'Limite de tentativas atingido nesta onda.'
             ),
             next_retry_at = null,
             next_check_at = null,
             error_reprocess_requested_at = null,
             claim_token = null,
             claimed_at = null,
             processing_owner = null,
             processing_started_at = null,
             processing_heartbeat_at = null,
             updated_at = now()
       where batch_id = new.batch_id
         and (new.target_member_link_id is null or id = new.target_member_link_id)
         and deleted_at is null
         and payment_status is distinct from 'paid'
         and processing_status in ('pending', 'queued', 'retrying', 'aguardando')
         and processing_attempts >= max_attempts
       returning id
    )
    select count(*)::int
      into exhausted_count
      from exhausted;

    if exhausted_count > 0 then
      new.error_items := new.error_items + exhausted_count;
      new.processed_items := greatest(
        new.processed_items,
        new.success_items + new.error_items
      );
      new.total_items := greatest(new.total_items, new.processed_items);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_settle_exhausted_wave_errors_v1
  on processing_jobs;

create trigger trg_settle_exhausted_wave_errors_v1
before update of status on processing_jobs
for each row
execute function settle_exhausted_wave_errors_v1();

insert into schema_migrations(version, name)
values (18, 'settle_exhausted_wave_errors')
on conflict (version) do nothing;
