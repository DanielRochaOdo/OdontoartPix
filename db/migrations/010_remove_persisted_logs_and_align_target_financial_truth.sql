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

-- Reconstroi o resumo financeiro somente quando existe a parcela-alvo
-- persistida. Valor (base_amount_cents) e a fonte do valor/pendencia;
-- ValorPago e a fonte do recebido. ValorFinal permanece apenas auxiliar.
with target_truth as (
  select
    cbm.id as campaign_batch_member_id,
    mi.base_amount_cents,
    mi.paid_amount_cents,
    nullif(trim(mi.payment_description), '') as payment_description,
    (
      mi.paid_amount_cents is not null
      and nullif(trim(mi.payment_description), '') is not null
      and upper(trim(mi.payment_description)) <> 'ABERTO'
    ) as is_explicit_paid
  from campaign_batch_members cbm
  join lateral (
    select mi.*
      from member_installments mi
     where mi.campaign_batch_member_id = cbm.id
       and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
     order by mi.updated_at desc, mi.created_at desc, mi.id desc
     limit 1
  ) mi on true
  where cbm.deleted_at is null
)
update campaign_batch_members cbm
   set installment_amount_cents = greatest(t.base_amount_cents, 0),
       payment_status = case when t.is_explicit_paid then 'paid' else 'unpaid' end,
       payment_status_source = case when t.is_explicit_paid then 'erp_explicit' else 'erp_open_invoice' end,
       payment_amount_cents = case when t.is_explicit_paid then greatest(coalesce(t.paid_amount_cents, 0), 0) else 0 end,
       total_pending_amount_cents = case when t.is_explicit_paid then 0 else greatest(t.base_amount_cents, 0) end,
       updated_at = now()
  from target_truth t
 where cbm.id = t.campaign_batch_member_id;

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

-- Esses objetos eram somente auditoria/log da fase inicial. O DROP e
-- intencionalmente sem CASCADE: uma dependencia SQL real deve bloquear a
-- migration, em vez de ser removida silenciosamente.
drop table if exists event_logs;
drop table if exists consultation_logs;

insert into schema_migrations(version, name)
values (10, 'remove_persisted_logs_and_align_target_financial_truth')
on conflict (version) do nothing;
