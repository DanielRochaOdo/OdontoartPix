-- Remove persistencia historica de logs/eventos da arquitetura local e
-- consolida a verdade financeira da parcela-alvo no proprio estado funcional.

alter table campaign_batch_members
  add column if not exists payment_status_source text,
  add column if not exists payment_amount_cents bigint not null default 0,
  add column if not exists processing_error_code text;

alter table campaign_batch_members
  drop constraint if exists campaign_batch_members_payment_amount_nonnegative;
alter table campaign_batch_members
  add constraint campaign_batch_members_payment_amount_nonnegative
  check (payment_amount_cents >= 0);

create index if not exists campaign_batch_members_processing_error_code_idx
  on campaign_batch_members(processing_error_code)
  where processing_error_code is not null;

-- Reconstroi a verdade financeira exclusivamente a partir da parcela-alvo
-- persistida, seguindo a mesma matriz estrita do runtime:
--   ABERTO => unpaid;
--   descricao diferente de ABERTO + ValorPago >= Valor => paid;
--   descricao ausente, ValorPago ausente/parcial ou parcela-alvo ausente => error.
-- Situacao e ValorFinal nao participam da decisao.
with target_truth as (
  select
    cbm.id as campaign_batch_member_id,
    mi.id as target_installment_row_id,
    mi.base_amount_cents,
    mi.paid_amount_cents,
    nullif(trim(mi.payment_description), '') as payment_description,
    upper(nullif(trim(mi.payment_description), '')) as normalized_payment_description
  from campaign_batch_members cbm
  left join lateral (
    select mi.*
      from member_installments mi
     where mi.campaign_batch_member_id = cbm.id
       and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
     order by mi.updated_at desc, mi.created_at desc, mi.id desc
     limit 1
  ) mi on true
  where cbm.deleted_at is null
), classified as (
  select
    t.*,
    case
      when t.target_installment_row_id is null then 'invalid'
      when t.normalized_payment_description = 'ABERTO' then 'unpaid'
      when t.normalized_payment_description is null then 'invalid'
      when t.paid_amount_cents is null then 'invalid'
      when t.paid_amount_cents >= t.base_amount_cents then 'paid'
      else 'invalid'
    end as financial_state,
    case
      when t.target_installment_row_id is null
        then 'A parcela alvo nao foi localizada no historico persistido do ERP.'
      when t.normalized_payment_description is null
        then 'A parcela alvo nao possui DescricaoRecebimento informada pelo ERP.'
      when t.normalized_payment_description <> 'ABERTO' and t.paid_amount_cents is null
        then 'A parcela alvo possui DescricaoRecebimento diferente de ABERTO sem ValorPago informado.'
      when t.normalized_payment_description <> 'ABERTO'
           and t.paid_amount_cents < t.base_amount_cents
        then 'A parcela alvo possui DescricaoRecebimento diferente de ABERTO, mas ValorPago e menor que Valor.'
      else null
    end as invalid_reason
  from target_truth t
)
update campaign_batch_members cbm
   set installment_amount_cents = case
         when c.target_installment_row_id is null then 0
         else greatest(c.base_amount_cents, 0)
       end,
       payment_status = case
         when c.financial_state = 'paid' then 'paid'
         when c.financial_state = 'unpaid' then 'unpaid'
         else null
       end,
       payment_status_source = case
         when c.financial_state = 'paid' then 'erp_explicit'
         when c.financial_state = 'unpaid' then 'erp_open_invoice'
         else null
       end,
       payment_amount_cents = case
         when c.financial_state = 'paid' then greatest(coalesce(c.paid_amount_cents, 0), 0)
         else 0
       end,
       total_pending_amount_cents = case
         when c.financial_state = 'unpaid' then greatest(c.base_amount_cents, 0)
         else 0
       end,
       processing_status = case
         when c.financial_state = 'invalid' then 'error'
         else cbm.processing_status
       end,
       processing_error_code = case
         when c.financial_state = 'invalid' then 'ERP_INVALID_RESPONSE'
         else null
       end,
       last_error = case
         when c.financial_state = 'invalid' then c.invalid_reason
         else cbm.last_error
       end,
       next_retry_at = case
         when c.financial_state = 'invalid' then null
         else cbm.next_retry_at
       end,
       next_check_at = case
         when c.financial_state = 'invalid' then null
         else cbm.next_check_at
       end,
       claim_token = case
         when c.financial_state = 'invalid' then null
         else cbm.claim_token
       end,
       claimed_at = case
         when c.financial_state = 'invalid' then null
         else cbm.claimed_at
       end,
       processing_owner = case
         when c.financial_state = 'invalid' then null
         else cbm.processing_owner
       end,
       processing_started_at = case
         when c.financial_state = 'invalid' then null
         else cbm.processing_started_at
       end,
       updated_at = now()
  from classified c
 where cbm.id = c.campaign_batch_member_id;

-- Estado tecnico e estado financeiro sao independentes. Nenhuma reabertura,
-- retry ou claim pode apagar a ultima verdade financeira confirmada.
create or replace function preserve_campaign_member_financial_truth_v1()
returns trigger
language plpgsql
as $$
begin
  if old.payment_status is not null
     and new.payment_status is null
     and new.processing_status in ('pending', 'queued', 'aguardando', 'processing', 'retrying', 'error') then
    new.payment_status := old.payment_status;
    new.payment_status_source := old.payment_status_source;
    new.installment_amount_cents := old.installment_amount_cents;
    new.payment_amount_cents := old.payment_amount_cents;
    new.total_pending_amount_cents := old.total_pending_amount_cents;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_preserve_campaign_member_financial_truth_v1
  on campaign_batch_members;
create trigger trg_preserve_campaign_member_financial_truth_v1
before update on campaign_batch_members
for each row
execute function preserve_campaign_member_financial_truth_v1();

-- Classifica timeouts ja existentes sem criar historico separado.
update campaign_batch_members
   set processing_error_code = 'ERP_TIMEOUT',
       updated_at = now()
 where processing_error_code is null
   and processing_status in ('error', 'retrying')
   and trim(coalesce(last_error, '')) = 'A consulta ao ERP excedeu o tempo limite.';

-- Recalcula os snapshots agregados dos lotes apos a reclassificacao para que
-- a UI nao exponha contadores/valores anteriores a verdade financeira atual.
with totals as (
  select
    batch_id,
    count(*)::int as total_records,
    count(*) filter (where processing_status = 'completed')::int as processed_records,
    count(*) filter (where payment_status = 'paid')::int as paid_records,
    count(*) filter (where payment_status = 'unpaid')::int as unpaid_records,
    count(*) filter (where processing_status = 'error')::int as error_records,
    coalesce(sum(total_pending_amount_cents), 0)::bigint as total_pending_amount_cents,
    count(*) filter (where processing_status = 'processing')::int as processing_records,
    count(*) filter (
      where processing_status in ('pending', 'queued', 'retrying', 'aguardando')
    )::int as waiting_records
  from campaign_batch_members
  where deleted_at is null
  group by batch_id
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
  from totals t
 where b.id = t.batch_id;

-- Esses objetos eram somente auditoria/log da fase inicial. O DROP e
-- intencionalmente sem CASCADE: uma dependencia SQL real deve bloquear a
-- migration, em vez de ser removida silenciosamente.
drop table if exists event_logs;
drop table if exists consultation_logs;

insert into schema_migrations(version, name)
values (10, 'remove_persisted_logs_and_align_target_financial_truth')
on conflict (version) do nothing;
