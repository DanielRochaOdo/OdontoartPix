-- Uma parcela e uma unica obrigacao financeira por associado + codigo da parcela.
-- Campanhas/lotes permanecem vinculos operacionais e nao multiplicam valores.

create table if not exists member_target_installments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  external_installment_code text not null,
  due_date_text text,
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  paid_amount_cents bigint check (paid_amount_cents is null or paid_amount_cents >= 0),
  pending_amount_cents bigint not null default 0 check (pending_amount_cents >= 0),
  payment_status text,
  payment_status_source text,
  payment_description text,
  payment_date_text text,
  amount_source text not null default 'import',
  last_erp_status_at timestamptz,
  financial_observed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_target_installments_code_not_blank
    check (nullif(trim(external_installment_code), '') is not null),
  constraint member_target_installments_unique_member_code
    unique(member_id, external_installment_code)
);

create index if not exists member_target_installments_member_idx
  on member_target_installments(member_id);
create index if not exists member_target_installments_payment_status_idx
  on member_target_installments(payment_status);

alter table campaign_batch_members
  add column if not exists target_installment_ref_id uuid
    references member_target_installments(id) on delete restrict;

create index if not exists campaign_batch_members_target_ref_idx
  on campaign_batch_members(target_installment_ref_id)
  where deleted_at is null;

-- Se houver dois estados divergentes observados no mesmo instante, nao e seguro
-- escolher silenciosamente um deles durante o backfill.
do $$
begin
  if exists (
    with candidates as (
      select
        cbm.member_id,
        trim(cbm.target_installment_id) as installment_code,
        coalesce(cbm.last_erp_status_at, cbm.last_checked_at, cbm.updated_at, cbm.created_at) as observed_at,
        concat_ws('|',
          coalesce(cbm.payment_status, ''),
          coalesce(cbm.installment_amount_cents::text, ''),
          coalesce(cbm.payment_amount_cents::text, ''),
          coalesce(cbm.total_pending_amount_cents::text, '')
        ) as financial_signature
      from campaign_batch_members cbm
      where cbm.deleted_at is null
        and nullif(trim(cbm.target_installment_id), '') is not null
    )
    select 1
      from candidates
     group by member_id, installment_code, observed_at
    having count(distinct financial_signature) > 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'canonical_installment_backfill_conflict';
  end if;
end;
$$;

-- Escolhe a verdade mais recente de cada associado + parcela. O snapshot da
-- parcela-alvo enriquece descricao/data/valor pago quando existir.
with ranked as (
  select
    cbm.*,
    trim(cbm.target_installment_id) as normalized_installment_code,
    target.base_amount_cents as target_base_amount_cents,
    target.paid_amount_cents as target_paid_amount_cents,
    target.payment_description as target_payment_description,
    target.payment_date_text as target_payment_date_text,
    row_number() over (
      partition by cbm.member_id, trim(cbm.target_installment_id)
      order by
        coalesce(cbm.last_erp_status_at, cbm.last_checked_at, cbm.updated_at, cbm.created_at) desc,
        cbm.updated_at desc,
        cbm.created_at desc,
        cbm.id desc
    ) as rn
  from campaign_batch_members cbm
  left join lateral (
    select
      mi.base_amount_cents,
      mi.paid_amount_cents,
      nullif(trim(mi.payment_description), '') as payment_description,
      nullif(trim(mi.payment_date_text), '') as payment_date_text
    from member_installments mi
    where mi.campaign_batch_member_id = cbm.id
      and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
    order by mi.updated_at desc, mi.created_at desc, mi.id desc
    limit 1
  ) target on true
  where cbm.deleted_at is null
    and nullif(trim(cbm.target_installment_id), '') is not null
), source as (
  select * from ranked where rn = 1
)
insert into member_target_installments(
  member_id,
  external_installment_code,
  due_date_text,
  amount_cents,
  paid_amount_cents,
  pending_amount_cents,
  payment_status,
  payment_status_source,
  payment_description,
  payment_date_text,
  amount_source,
  last_erp_status_at,
  financial_observed_at,
  created_at,
  updated_at
)
select
  source.member_id,
  source.normalized_installment_code,
  source.due_date_text,
  greatest(coalesce(source.target_base_amount_cents, source.installment_amount_cents, 0), 0),
  case
    when source.payment_status = 'agreed' then 0
    else greatest(coalesce(source.target_paid_amount_cents, source.payment_amount_cents, 0), 0)
  end,
  greatest(coalesce(source.total_pending_amount_cents, 0), 0),
  source.payment_status,
  source.payment_status_source,
  source.target_payment_description,
  source.target_payment_date_text,
  case when source.last_erp_status_at is not null then 'erp' else 'import' end,
  source.last_erp_status_at,
  coalesce(source.last_erp_status_at, source.last_checked_at, source.updated_at, source.created_at),
  source.created_at,
  source.updated_at
from source
on conflict (member_id, external_installment_code) do nothing;

update campaign_batch_members cbm
   set target_installment_ref_id = canonical.id,
       target_installment_id = canonical.external_installment_code
  from member_target_installments canonical
 where cbm.member_id = canonical.member_id
   and nullif(trim(cbm.target_installment_id), '') is not null
   and trim(cbm.target_installment_id) = canonical.external_installment_code;

-- A mesma parcela pode estar em varios lotes, mas apenas uma vez em cada lote.
do $$
begin
  if exists (
    select 1
      from campaign_batch_members cbm
     where cbm.deleted_at is null
       and cbm.target_installment_ref_id is not null
     group by cbm.batch_id, cbm.target_installment_ref_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'duplicate_canonical_installment_in_same_batch';
  end if;
end;
$$;

create unique index if not exists campaign_batch_members_batch_target_ref_unique
  on campaign_batch_members(batch_id, target_installment_ref_id)
  where deleted_at is null and target_installment_ref_id is not null;

-- Durante uma sincronizacao entre vinculos, nao reinterpreta um snapshot antigo
-- do lote como uma nova verdade ACORDADO.
create or replace function apply_agreed_financial_truth_v1()
returns trigger
language plpgsql
as $$
declare
  target_description text;
  target_amount_cents bigint;
begin
  if current_setting('odontoart.canonical_sync', true) = 'on' then
    return new;
  end if;

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

-- Vincula automaticamente uma nova ocorrencia de lote ao registro financeiro.
-- A importacao nunca apaga estado financeiro ja confirmado.
create or replace function bind_campaign_batch_member_target_v1()
returns trigger
language plpgsql
as $$
declare
  v_code text;
  v_target member_target_installments%rowtype;
begin
  v_code := nullif(trim(new.target_installment_id), '');
  if v_code is null then
    return new;
  end if;

  new.target_installment_id := v_code;

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
    greatest(coalesce(new.installment_amount_cents, 0), 0),
    greatest(coalesce(new.payment_amount_cents, 0), 0),
    greatest(coalesce(new.total_pending_amount_cents, 0), 0),
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

  return new;
end;
$$;

drop trigger if exists trg_bind_campaign_batch_member_target_v1
  on campaign_batch_members;
create trigger trg_bind_campaign_batch_member_target_v1
before insert or update of member_id, target_installment_id, due_date_text
on campaign_batch_members
for each row
execute function bind_campaign_batch_member_target_v1();

-- Recalculo central de lote. Contadores sao operacionais por vinculo; dinheiro
-- vem da parcela canonica. A unicidade no lote impede dupla soma nesse escopo.
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
            and (canonical.payment_status is null or canonical.payment_status not in ('paid', 'agreed'))
        )::int as error_records,
        coalesce(sum(canonical.pending_amount_cents), 0)::bigint as total_pending_amount_cents,
        coalesce(sum(canonical.amount_cents), 0)::bigint as total_amount_cents,
        count(*) filter (where cbm.processing_status = 'processing')::int as processing_records,
        count(*) filter (
          where cbm.processing_status in ('pending', 'queued', 'retrying', 'aguardando')
            and (canonical.payment_status is null or canonical.payment_status not in ('paid', 'agreed'))
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

-- Espelha a verdade financeira em todos os vinculos para manter compatibilidade
-- com o worker/filas existentes. Paid e agreed continuam fora do automatico;
-- reprocessamento manual por target_member_link_id permanece permitido.
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
           when v_target.payment_status in ('paid', 'agreed') then 'completed'
           when cbm.payment_status in ('paid', 'agreed') and v_target.payment_status = 'unpaid' then 'pending'
           else cbm.processing_status
         end,
         next_check_at = case
           when v_target.payment_status in ('paid', 'agreed') then null
           when cbm.payment_status in ('paid', 'agreed') and v_target.payment_status = 'unpaid' then now()
           else cbm.next_check_at
         end,
         next_retry_at = case
           when v_target.payment_status in ('paid', 'agreed') then null
           else cbm.next_retry_at
         end,
         updated_at = now()
   where cbm.target_installment_ref_id = p_target_installment_id
     and cbm.deleted_at is null;

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

-- O worker grava o snapshot ERP antes de finalizar o vinculo. Depois dos
-- triggers financeiros locais (inclusive ACORDADO e pagamento parcial), este
-- AFTER promove exatamente o estado final para o canonico.
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
  v_updated_count integer := 0;
begin
  if pg_trigger_depth() > 1 or new.target_installment_ref_id is null then
    return new;
  end if;

  v_observed_at := coalesce(
    old.claimed_at,
    new.last_erp_status_at,
    new.last_checked_at,
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

  update member_target_installments target
     set due_date_text = coalesce(new.due_date_text, target.due_date_text),
         amount_cents = greatest(coalesce(v_base_amount, new.installment_amount_cents, target.amount_cents, 0), 0),
         paid_amount_cents = case
           when new.payment_status = 'agreed' then 0
           else greatest(coalesce(v_paid_amount, new.payment_amount_cents, 0), 0)
         end,
         pending_amount_cents = greatest(coalesce(new.total_pending_amount_cents, 0), 0),
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

  get diagnostics v_updated_count = row_count;
  if v_updated_count > 0 then
    perform sync_target_installment_links_v1(new.target_installment_ref_id);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_capture_campaign_batch_member_financial_truth_v1
  on campaign_batch_members;
create trigger trg_capture_campaign_batch_member_financial_truth_v1
after update of
  payment_status,
  payment_status_source,
  installment_amount_cents,
  payment_amount_cents,
  total_pending_amount_cents,
  last_erp_status_at
on campaign_batch_members
for each row
execute function capture_campaign_batch_member_financial_truth_v1();

-- Mantem metadados de recebimento disponiveis no canonico antes da atualizacao
-- final do vinculo. Status/pendencia continuam sendo promovidos pelo trigger acima.
create or replace function capture_member_installment_target_details_v1()
returns trigger
language plpgsql
as $$
declare
  v_target_id uuid;
  v_target_code text;
begin
  select cbm.target_installment_ref_id, cbm.target_installment_id
    into v_target_id, v_target_code
    from campaign_batch_members cbm
   where cbm.id = new.campaign_batch_member_id;

  if v_target_id is null
     or trim(coalesce(new.cod_parcela, '')) <> trim(coalesce(v_target_code, '')) then
    return new;
  end if;

  update member_target_installments
     set payment_description = coalesce(nullif(trim(new.payment_description), ''), payment_description),
         payment_date_text = coalesce(nullif(trim(new.payment_date_text), ''), payment_date_text),
         updated_at = now()
   where id = v_target_id;

  return new;
end;
$$;

drop trigger if exists trg_capture_member_installment_target_details_v1
  on member_installments;
create trigger trg_capture_member_installment_target_details_v1
after insert or update of cod_parcela, payment_description, payment_date_text
on member_installments
for each row
execute function capture_member_installment_target_details_v1();

-- Compatibilidade para consultas que ainda usam a view de parcela-alvo.
create or replace view target_installment_payment_v1 as
select
  cbm.id as campaign_batch_member_id,
  cbm.campaign_id,
  cbm.batch_id,
  cbm.member_id,
  cbm.target_installment_id,
  cbm.processing_status,
  canonical.payment_status as stored_payment_status,
  canonical.payment_status_source,
  canonical.amount_cents::bigint as target_amount_cents,
  canonical.paid_amount_cents::bigint as target_paid_amount_cents,
  canonical.payment_description,
  canonical.payment_status = 'paid' as is_explicit_paid,
  canonical.pending_amount_cents::bigint as target_open_amount_cents,
  canonical.id as target_installment_row_id,
  canonical.updated_at as target_installment_updated_at
from campaign_batch_members cbm
join member_target_installments canonical
  on canonical.id = cbm.target_installment_ref_id
where cbm.deleted_at is null;

-- Alinha os caches e os totais existentes apos o backfill.
do $$
declare
  v_target record;
  v_batch record;
begin
  for v_target in select id from member_target_installments loop
    perform sync_target_installment_links_v1(v_target.id);
  end loop;

  for v_batch in select id from campaign_batches where deleted_at is null loop
    perform recalculate_batch_totals(v_batch.id);
  end loop;
end;
$$;

insert into schema_migrations(version, name)
values (23, 'canonical_target_installments')
on conflict (version) do nothing;
