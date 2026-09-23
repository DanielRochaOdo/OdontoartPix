-- DescricaoPagamento = forma configurada no ERP para a parcela.
-- DescricaoRecebimento = forma efetiva de recebimento, ja persistida em payment_description.
-- Nao inferir a configurada de observation: este campo tambem recebe Observacao do ERP.
alter table member_installments
  add column if not exists configured_payment_description text;

alter table member_target_installments
  add column if not exists configured_payment_description text;

comment on column member_installments.configured_payment_description is
  'DescricaoPagamento retornada para esta parcela pelo ERP, sem inferencia a partir de Observacao.';
comment on column member_target_installments.configured_payment_description is
  'Ultima DescricaoPagamento observada do ERP para a obrigacao financeira canonica. Nulo quando ainda nao coletada.';

-- Copia apenas o snapshot ERP da parcela-alvo; uma mesma obrigacao em
-- mais de um lote/campanha continua tendo uma configuracao canonica unica.
create or replace function capture_member_installment_configured_payment_v1()
returns trigger
language plpgsql
as $$
declare
  v_target_id uuid;
  v_target_code text;
begin
  select target_installment_ref_id, target_installment_id
    into v_target_id, v_target_code
    from campaign_batch_members
   where id = new.campaign_batch_member_id;

  if v_target_id is null
     or trim(coalesce(new.cod_parcela, '')) <> trim(coalesce(v_target_code, '')) then
    return new;
  end if;

  update member_target_installments
     set configured_payment_description = nullif(trim(new.configured_payment_description), ''),
         updated_at = now()
   where id = v_target_id
     and configured_payment_description is distinct from nullif(trim(new.configured_payment_description), '');

  return new;
end;
$$;

drop trigger if exists trg_capture_member_installment_configured_payment_v1
  on member_installments;
create trigger trg_capture_member_installment_configured_payment_v1
after insert or update of configured_payment_description, cod_parcela
on member_installments
for each row execute function capture_member_installment_configured_payment_v1();

-- Nao retropreencher com payment_description: este representa DescricaoRecebimento,
-- e nao o metodo configurado. Historico sem DescricaoPagamento requer nova leitura ERP.
