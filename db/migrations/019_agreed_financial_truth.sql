-- Introduz ACORDADO como terceira verdade financeira persistida.
-- agreed nao e pago, nao compoe pendencia e nao volta para sincronizacoes gerais.

create index if not exists campaign_batch_members_agreed_idx
  on campaign_batch_members(payment_status, batch_id)
  where deleted_at is null and payment_status = 'agreed';

create or replace function apply_agreed_financial_truth_v1()
returns trigger
language plpgsql
as $$
declare
  target_description text;
  target_amount_cents bigint;
begin
  -- Sincronizacoes gerais preparam o lote zerando next_check_at. Uma parcela
  -- acordada deve permanecer terminal nesse fluxo. O reprocessamento manual
  -- isolado define next_check_at explicitamente e, portanto, continua permitido.
  if old.payment_status = 'agreed'
     and new.payment_status = 'agreed'
     and old.processing_status = 'completed'
     and new.processing_status in ('pending', 'queued', 'aguardando', 'retrying')
     and new.next_check_at is null then
    new.processing_status := 'completed';
    new.next_retry_at := null;
    new.processing_owner := null;
    new.processing_started_at := null;
    new.processing_heartbeat_at := null;
    new.claim_token := null;
    new.claimed_at := null;
  end if;

  -- O worker persiste primeiro o historico retornado pelo ERP e depois atualiza
  -- campaign_batch_members. Nesse ponto a parcela-alvo ja pode ser consultada e
  -- ACORDADO passa a ter precedencia sobre paid/unpaid.
  if new.processing_status = 'completed' then
    select nullif(trim(mi.payment_description), ''), greatest(mi.base_amount_cents, 0)
      into target_description, target_amount_cents
      from member_installments mi
     where mi.campaign_batch_member_id = new.id
       and trim(mi.cod_parcela) = trim(new.target_installment_id)
     order by mi.updated_at desc, mi.created_at desc, mi.id desc
     limit 1;

    if upper(coalesce(target_description, '')) = 'ACORDADO' then
      new.payment_status := 'agreed';
      new.payment_status_source := 'erp_agreed';
      new.installment_amount_cents := coalesce(target_amount_cents, new.installment_amount_cents, 0);
      new.payment_amount_cents := 0;
      new.total_pending_amount_cents := 0;
      new.next_check_at := null;
      new.next_retry_at := null;
      new.processing_error_code := null;
      new.last_error := null;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_apply_agreed_financial_truth_v1
  on campaign_batch_members;
create trigger trg_apply_agreed_financial_truth_v1
before update on campaign_batch_members
for each row
execute function apply_agreed_financial_truth_v1();

-- Reclassifica o historico ja persistido. Registros que estejam efetivamente
-- em processamento ficam para o novo worker/trigger concluir com seguranca.
with agreed_targets as (
  select
    cbm.id,
    greatest(mi.base_amount_cents, 0) as base_amount_cents
  from campaign_batch_members cbm
  join lateral (
    select mi.base_amount_cents, mi.payment_description
      from member_installments mi
     where mi.campaign_batch_member_id = cbm.id
       and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
     order by mi.updated_at desc, mi.created_at desc, mi.id desc
     limit 1
  ) mi on true
  where cbm.deleted_at is null
    and cbm.processing_status <> 'processing'
    and upper(trim(coalesce(mi.payment_description, ''))) = 'ACORDADO'
)
update campaign_batch_members cbm
   set payment_status = 'agreed',
       payment_status_source = 'erp_agreed',
       installment_amount_cents = a.base_amount_cents,
       payment_amount_cents = 0,
       total_pending_amount_cents = 0,
       processing_status = 'completed',
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
  from agreed_targets a
 where cbm.id = a.id;

insert into schema_migrations(version, name)
values (19, 'agreed_financial_truth')
on conflict (version) do nothing;
