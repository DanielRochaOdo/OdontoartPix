-- Introduz EXCLUIDA como quarta verdade financeira persistida.
-- excluded nao e pago, nao compoe pendencia e nao volta para sincronizacoes gerais.
-- O registro canonico permanece para historico e uma reconciliacao manual isolada
-- continua apta a substituir essa verdade por um retorno ERP mais recente.

create index if not exists campaign_batch_members_excluded_idx
  on campaign_batch_members(payment_status, batch_id)
  where deleted_at is null and payment_status = 'excluded';

-- Mantem o trigger historico de ACORDADO, ampliando-o para tratar EXCLUIDA com
-- a mesma semantica terminal, sem apagar o registro financeiro.
create or replace function apply_agreed_financial_truth_v1()
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

  -- Sincronizacoes gerais preparam o lote zerando next_check_at. Estados
  -- terminais permanecem concluidos. O reprocessamento manual isolado define
  -- next_check_at explicitamente e continua permitido.
  if old.payment_status in ('agreed', 'excluded')
     and new.payment_status = old.payment_status
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

-- Vincula novas ocorrencias ao canonico preservando paid/agreed/excluded como
-- estados terminais e sempre zerando valor pago/pendencia dos nao recebimentos.
create or replace function bind_campaign_batch_member_target_v1()
returns trigger
language plpgsql
as $$
declare
  v_code text;
  v_amount bigint;
  v_paid bigint;
  v_pending bigint;
  v_target member_target_installments%rowtype;
begin
  v_code := nullif(trim(new.target_installment_id), '');
  if v_code is null then
    return new;
  end if;

  new.target_installment_id := v_code;
  v_amount := greatest(coalesce(new.installment_amount_cents, 0), 0);
  v_paid := greatest(coalesce(new.payment_amount_cents, 0), 0);
  v_pending := case
    when new.payment_status in ('agreed', 'excluded') then 0
    when new.payment_status = 'paid' and new.payment_status_source = 'erp_explicit'
      then greatest(v_amount - v_paid, 0)
    else greatest(coalesce(new.total_pending_amount_cents, 0), 0)
  end;

  insert into member_target_installments(
    member_id,
    external_installment_code,
    due_date_text,
    amount_cents,
    paid_amount_cents,
    pending_amount_cents,
    payment_status,
    payment_status_source,
    amount_source,
    financial_observed_at
  ) values (
    new.member_id,
    v_code,
    new.due_date_text,
    v_amount,
    case when new.payment_status in ('agreed', 'excluded') then 0 else v_paid end,
    v_pending,
    new.payment_status,
    new.payment_status_source,
    'import',
    coalesce(new.last_erp_status_at, new.last_checked_at, new.updated_at, now())
  )
  on conflict (member_id, external_installment_code)
  do update set
    due_date_text = coalesce(member_target_installments.due_date_text, excluded.due_date_text),
    updated_at = now()
  returning * into v_target;

  new.target_installment_ref_id := v_target.id;
  new.installment_amount_cents := v_target.amount_cents;

  if v_target.payment_status is not null or v_target.last_erp_status_at is not null then
    new.payment_amount_cents := coalesce(v_target.paid_amount_cents, 0);
    new.total_pending_amount_cents := v_target.pending_amount_cents;
    new.payment_status := v_target.payment_status;
    new.payment_status_source := v_target.payment_status_source;
    new.last_erp_status_at := v_target.last_erp_status_at;
  end if;

  if v_target.payment_status in ('paid', 'agreed', 'excluded') then
    new.processing_status := 'completed';
    new.processing_attempts := 0;
    new.stale_reclaim_count := 0;
    new.next_check_at := null;
    new.next_retry_at := null;
    new.processing_owner := null;
    new.processing_started_at := null;
    new.processing_heartbeat_at := null;
    new.claim_token := null;
    new.claimed_at := null;
    new.error_reprocess_requested_at := null;
    new.processing_error_code := null;
    new.last_error := null;
  end if;

  return new;
end;
$$;

-- Recalculo central de lote: EXCLUIDA continua compondo o valor nominal do
-- lote, como historico da obrigacao, mas nao e paga, aberta, erro ou espera.
create or replace function recalculate_batch_totals(p_batch_id uuid)
returns void
language plpgsql
as $$
begin
  update campaign_batches b
     set total_records = totals.total_records,
         processed_records = totals.processed_records,
         paid_records = totals.paid_records,
         unpaid_records = totals.unpaid_records,
         error_records = totals.error_records,
         total_pending_amount_cents = totals.total_pending_amount_cents,
         total_amount_cents = totals.total_amount_cents,
         status = case
                    when totals.processing_records > 0 then 'processando'
                    when totals.waiting_records > 0 then 'aguardando'
                    when totals.error_records > 0 then 'concluido_com_erros'
                    when totals.total_records > 0 and totals.processed_records = totals.total_records then 'concluido'
                    else 'aguardando'
                  end,
         updated_at = now()
    from (
      select
        count(*)::int as total_records,
        count(*) filter (where cbm.processing_status = 'completed')::int as processed_records,
        count(*) filter (where canonical.payment_status = 'paid')::int as paid_records,
        count(*) filter (where canonical.payment_status = 'unpaid')::int as unpaid_records,
        count(*) filter (
          where cbm.processing_status = 'error'
            and (canonical.payment_status is null or canonical.payment_status not in ('paid', 'agreed', 'excluded'))
        )::int as error_records,
        coalesce(sum(canonical.pending_amount_cents), 0)::bigint as total_pending_amount_cents,
        coalesce(sum(canonical.amount_cents), 0)::bigint as total_amount_cents,
        count(*) filter (where cbm.processing_status = 'processing')::int as processing_records,
        count(*) filter (
          where cbm.processing_status in ('pending', 'queued', 'retrying', 'aguardando')
            and (canonical.payment_status is null or canonical.payment_status not in ('paid', 'agreed', 'excluded'))
        )::int as waiting_records
      from campaign_batch_members cbm
      left join member_target_installments canonical
        on canonical.id = cbm.target_installment_ref_id
      where cbm.batch_id = p_batch_id
        and cbm.deleted_at is null
    ) totals
   where b.id = p_batch_id;
end;
$$;

-- Propaga a verdade canonica para todos os vinculos. Um excluded atual fica
-- fora do automatico, mas uma reconciliacao manual posterior pode promover uma
-- verdade ERP mais recente para unpaid/paid/agreed.
create or replace function sync_target_installment_links_v1(p_target_installment_id uuid)
returns void
language plpgsql
as $$
declare
  v_target member_target_installments%rowtype;
  v_batch record;
begin
  select * into v_target
    from member_target_installments
   where id = p_target_installment_id;

  if not found then
    return;
  end if;

  perform set_config('odontoart.canonical_sync', 'on', true);

  update campaign_batch_members cbm
     set installment_amount_cents = v_target.amount_cents,
         payment_amount_cents = coalesce(v_target.paid_amount_cents, 0),
         total_pending_amount_cents = v_target.pending_amount_cents,
         payment_status = v_target.payment_status,
         payment_status_source = v_target.payment_status_source,
         due_date_text = coalesce(v_target.due_date_text, cbm.due_date_text),
         last_erp_status_at = coalesce(v_target.last_erp_status_at, cbm.last_erp_status_at),
         processing_status = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then 'completed'
           when cbm.payment_status in ('paid', 'agreed', 'excluded') and v_target.payment_status = 'unpaid' then 'pending'
           else cbm.processing_status
         end,
         processing_attempts = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then 0
           else cbm.processing_attempts
         end,
         stale_reclaim_count = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then 0
           else cbm.stale_reclaim_count
         end,
         next_check_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           when cbm.payment_status in ('paid', 'agreed', 'excluded') and v_target.payment_status = 'unpaid' then now()
           else cbm.next_check_at
         end,
         next_retry_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.next_retry_at
         end,
         processing_owner = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.processing_owner
         end,
         processing_started_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.processing_started_at
         end,
         processing_heartbeat_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.processing_heartbeat_at
         end,
         claim_token = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.claim_token
         end,
         claimed_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.claimed_at
         end,
         error_reprocess_requested_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.error_reprocess_requested_at
         end,
         processing_error_code = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.processing_error_code
         end,
         last_error = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.last_error
         end,
         updated_at = now()
   where cbm.target_installment_ref_id = p_target_installment_id
     and cbm.deleted_at is null
     and cbm.processing_status <> 'processing';

  perform set_config('odontoart.canonical_sync', 'off', true);

  for v_batch in
    select distinct cbm.batch_id
      from campaign_batch_members cbm
     where cbm.target_installment_ref_id = p_target_installment_id
       and cbm.deleted_at is null
  loop
    perform recalculate_batch_totals(v_batch.batch_id);
  end loop;
end;
$$;

-- Evita que uma consulta iniciada antes de um terminal mais recente reverta a
-- verdade canonica quando concluir depois.
create or replace function capture_campaign_batch_member_financial_truth_v1()
returns trigger
language plpgsql
as $$
declare
  v_observed_at timestamptz;
  v_description text;
  v_payment_date text;
  v_paid_amount bigint;
  v_base_amount bigint;
  v_current_status text;
  v_current_observed_at timestamptz;
  v_stale_terminal_reversal boolean := false;
begin
  if pg_trigger_depth() > 1 or new.target_installment_ref_id is null then
    return new;
  end if;

  select payment_status, financial_observed_at
    into v_current_status, v_current_observed_at
    from member_target_installments
   where id = new.target_installment_ref_id
   for update;

  v_stale_terminal_reversal :=
    v_current_status in ('paid', 'agreed', 'excluded')
    and coalesce(new.payment_status, '') not in ('paid', 'agreed', 'excluded')
    and old.claimed_at is not null
    and v_current_observed_at is not null
    and old.claimed_at < v_current_observed_at;

  v_observed_at := coalesce(
    new.last_erp_status_at,
    new.last_checked_at,
    old.claimed_at,
    new.updated_at,
    now()
  );

  select
    nullif(trim(mi.payment_description), ''),
    nullif(trim(mi.payment_date_text), ''),
    mi.paid_amount_cents,
    mi.base_amount_cents
    into v_description, v_payment_date, v_paid_amount, v_base_amount
    from member_installments mi
   where mi.campaign_batch_member_id = new.id
     and trim(mi.cod_parcela) = trim(new.target_installment_id)
   order by mi.updated_at desc, mi.created_at desc, mi.id desc
   limit 1;

  if not v_stale_terminal_reversal then
    update member_target_installments target
       set due_date_text = coalesce(new.due_date_text, target.due_date_text),
           amount_cents = greatest(coalesce(v_base_amount, new.installment_amount_cents, target.amount_cents, 0), 0),
           paid_amount_cents = case
             when new.payment_status in ('agreed', 'excluded') then 0
             else greatest(coalesce(v_paid_amount, new.payment_amount_cents, 0), 0)
           end,
           pending_amount_cents = case
             when new.payment_status in ('agreed', 'excluded') then 0
             else greatest(coalesce(new.total_pending_amount_cents, 0), 0)
           end,
           payment_status = new.payment_status,
           payment_status_source = new.payment_status_source,
           payment_description = coalesce(v_description, target.payment_description),
           payment_date_text = coalesce(v_payment_date, target.payment_date_text),
           amount_source = case
             when coalesce(new.payment_status_source, '') like 'erp_%' or new.last_erp_status_at is not null
               then 'erp'
             else target.amount_source
           end,
           last_erp_status_at = coalesce(new.last_erp_status_at, target.last_erp_status_at),
           financial_observed_at = v_observed_at,
           updated_at = now()
     where target.id = new.target_installment_ref_id
       and (target.financial_observed_at is null or v_observed_at >= target.financial_observed_at);
  end if;

  perform sync_target_installment_links_v1(new.target_installment_ref_id);

  return new;
end;
$$;

-- Reclassifica snapshots EXCLUIDA ja persistidos. Registros atualmente em
-- processamento ficam para o worker/trigger concluir sem interromper claims.
with excluded_targets as (
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
    and upper(trim(coalesce(mi.payment_description, ''))) = 'EXCLUIDA'
)
update campaign_batch_members cbm
   set payment_status = 'excluded',
       payment_status_source = 'erp_excluded',
       installment_amount_cents = e.base_amount_cents,
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
  from excluded_targets e
 where cbm.id = e.id;

-- Tambem corrige canonicos sem snapshot operacional disponivel, desde que a
-- descricao canonica atual seja explicitamente EXCLUIDA.
update member_target_installments
   set payment_status = 'excluded',
       payment_status_source = 'erp_excluded',
       paid_amount_cents = 0,
       pending_amount_cents = 0,
       amount_source = 'erp',
       updated_at = now()
 where upper(trim(coalesce(payment_description, ''))) = 'EXCLUIDA';

do $$
declare
  v_target record;
begin
  for v_target in
    select id
      from member_target_installments
     where payment_status = 'excluded'
  loop
    perform sync_target_installment_links_v1(v_target.id);
  end loop;
end;
$$;

insert into schema_migrations(version, name)
values (31, 'excluded_financial_truth')
on conflict (version) do nothing;
