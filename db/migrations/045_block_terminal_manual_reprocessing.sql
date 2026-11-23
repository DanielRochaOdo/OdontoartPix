-- Bloqueia reabertura manual de parcelas com verdade terminal do ERP.
-- Mantem recuperacao de erros tecnicos de parcelas abertas.
-- Nao altera pagamentos, historicos, vinculos nem formulas de totais.
create or replace function public.apply_agreed_financial_truth_v1()
returns trigger
language plpgsql
as $$
declare
  target_description text;
  target_amount_cents bigint;
  target_status text;
  target_status_source text;
begin
  if current_setting('odontoart.canonical_sync', true) = 'on' then
    return new;
  end if;

  -- Nenhuma parcela terminal pode voltar a fila por reprocessamento manual,
  -- mesmo com next_check_at definido explicitamente.
  if old.payment_status in ('paid', 'agreed', 'excluded')
     and new.payment_status = old.payment_status then
    new.processing_status := 'completed';
    new.processing_attempts := 0;
    new.stale_reclaim_count := 0;
    new.next_check_at := null;
    new.next_retry_at := null;
    new.error_reprocess_requested_at := null;
    new.processing_error_code := null;
    new.last_error := null;
    new.processing_owner := null;
    new.processing_started_at := null;
    new.processing_heartbeat_at := null;
    new.claim_token := null;
    new.claimed_at := null;
  end if;

  -- O snapshot ERP da parcela-alvo tem precedencia sobre classificacoes
  -- genericas de paid/unpaid para ACORDADO e EXCLUIDA.
  if new.processing_status = 'completed' then
    select nullif(trim(mi.payment_description), ''), greatest(mi.base_amount_cents, 0)
      into target_description, target_amount_cents
      from member_installments mi
     where mi.campaign_batch_member_id = new.id
       and trim(mi.cod_parcela) = trim(new.target_installment_id)
     order by mi.updated_at desc, mi.created_at desc, mi.id desc
     limit 1;

    target_status := case upper(coalesce(target_description, ''))
      when 'ACORDADO' then 'agreed'
      when 'EXCLUIDA' then 'excluded'
      else null
    end;
    target_status_source := case target_status
      when 'agreed' then 'erp_agreed'
      when 'excluded' then 'erp_excluded'
      else null
    end;

    if target_status is not null then
      new.payment_status := target_status;
      new.payment_status_source := target_status_source;
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

insert into public.schema_migrations(version, name)
values (45, 'block_terminal_manual_reprocessing')
on conflict (version) do nothing;
