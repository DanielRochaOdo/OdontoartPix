-- Repara estados produzidos antes da correcao do contrato de pagamento parcial.
--
-- Regra de dominio:
-- - payment_status = paid/agreed representa verdade financeira terminal;
-- - erro tecnico de uma reconciliacao posterior nao transforma essa verdade em
--   erro financeiro do associado;
-- - jobs individuais ativos continuam sendo preservados para que uma
--   reconciliacao explicitamente solicitada pelo operador possa terminar.

with repaired as (
  update campaign_batch_members cbm
     set processing_status = 'completed',
         processing_attempts = 0,
         stale_reclaim_count = 0,
         next_check_at = null,
         next_retry_at = null,
         processing_owner = null,
         processing_started_at = null,
         processing_heartbeat_at = null,
         claim_token = null,
         claimed_at = null,
         processing_error_code = null,
         last_error = null,
         error_reprocess_requested_at = null,
         updated_at = now()
   where cbm.deleted_at is null
     and cbm.payment_status in ('paid', 'agreed')
     and cbm.processing_status in ('pending', 'queued', 'aguardando', 'retrying', 'error', 'failed')
     and not exists (
       select 1
         from processing_jobs pj
        where pj.target_member_link_id = cbm.id
          and pj.processing_scope = 'member'
          and pj.status in ('queued', 'running', 'paused', 'deferred')
     )
  returning cbm.batch_id
), affected_batches as (
  select distinct batch_id from repaired
), batch_totals as (
  select
    cbm.batch_id,
    count(*)::int as total_records,
    count(*) filter (where cbm.processing_status = 'completed')::int as processed_records,
    count(*) filter (where cbm.payment_status = 'paid')::int as paid_records,
    count(*) filter (where cbm.payment_status = 'unpaid')::int as unpaid_records,
    count(*) filter (
      where cbm.processing_status = 'error'
        and (cbm.payment_status is null or cbm.payment_status not in ('paid', 'agreed'))
    )::int as error_records,
    coalesce(sum(cbm.total_pending_amount_cents), 0)::bigint as total_pending_amount_cents,
    count(*) filter (where cbm.processing_status = 'processing')::int as processing_records,
    count(*) filter (
      where cbm.processing_status in ('pending', 'queued', 'retrying', 'aguardando')
        and (cbm.payment_status is null or cbm.payment_status not in ('paid', 'agreed'))
    )::int as waiting_records
  from campaign_batch_members cbm
  join affected_batches ab on ab.batch_id = cbm.batch_id
  where cbm.deleted_at is null
  group by cbm.batch_id
)
update campaign_batches b
   set total_records = t.total_records,
       processed_records = t.processed_records,
       paid_records = t.paid_records,
       unpaid_records = t.unpaid_records,
       error_records = t.error_records,
       total_pending_amount_cents = t.total_pending_amount_cents,
       status = case
                  when t.processing_records > 0 then 'processando'
                  when t.waiting_records > 0 then 'aguardando'
                  when t.error_records > 0 then 'concluido_com_erros'
                  else 'concluido'
                end,
       updated_at = now()
  from batch_totals t
 where b.id = t.batch_id;

insert into schema_migrations(version, name)
values (22, 'repair_terminal_financial_processing_state')
on conflict (version) do nothing;
