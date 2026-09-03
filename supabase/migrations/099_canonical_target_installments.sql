-- Canonicaliza a parcela financeira para permitir o mesmo titulo em varios lotes/campanhas
-- sem multiplicar valor ou divergir status financeiro.

create table if not exists public.member_target_installments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  external_installment_code text not null,
  due_date_text text,
  amount_cents bigint not null default 0,
  paid_amount_cents bigint,
  pending_amount_cents bigint not null default 0,
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
    check (nullif(btrim(external_installment_code), '') is not null),
  constraint member_target_installments_unique_member_code
    unique (member_id, external_installment_code)
);

create index if not exists idx_member_target_installments_member
  on public.member_target_installments(member_id);
create index if not exists idx_member_target_installments_payment_status
  on public.member_target_installments(payment_status);
create index if not exists idx_member_target_installments_code
  on public.member_target_installments(external_installment_code);

alter table if exists public.campaign_batch_members
  add column if not exists target_installment_ref_id uuid
    references public.member_target_installments(id) on delete restrict;

create index if not exists idx_cbm_target_installment_ref
  on public.campaign_batch_members(target_installment_ref_id)
  where deleted_at is null;

-- Detecta conflitos historicos impossiveis de resolver deterministicamente.
do $$
begin
  if exists (
    with candidates as (
      select
        cbm.member_id,
        btrim(cbm.target_installment_id) as installment_code,
        coalesce(cbm.last_erp_status_at, cbm.last_checked_at, cbm.updated_at, cbm.created_at) as observed_at,
        concat_ws('|',
          coalesce(cbm.payment_status, ''),
          coalesce(cbm.installment_amount_cents::text, ''),
          coalesce(cbm.payment_amount_cents::text, ''),
          coalesce(cbm.total_pending_amount_cents::text, '')
        ) as financial_signature
      from public.campaign_batch_members cbm
      where cbm.deleted_at is null
        and nullif(btrim(cbm.target_installment_id), '') is not null
    )
    select 1
    from candidates
    group by member_id, installment_code, observed_at
    having count(distinct financial_signature) > 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'canonical_installment_backfill_conflict',
      detail = 'Existem verdades financeiras divergentes para a mesma parcela no mesmo instante.';
  end if;
end;
$$;

-- Backfill: a ultima verdade conhecida do ERP/vinculo vence para cada associado + parcela.
with ranked as (
  select
    cbm.*,
    btrim(cbm.target_installment_id) as normalized_installment_code,
    target.base_amount_cents as target_base_amount_cents,
    target.paid_amount_cents as target_paid_amount_cents,
    target.payment_description as target_payment_description,
    target.payment_date_text as target_payment_date_text,
    row_number() over (
      partition by cbm.member_id, btrim(cbm.target_installment_id)
      order by
        coalesce(cbm.last_erp_status_at, cbm.last_checked_at, cbm.updated_at, cbm.created_at) desc,
        cbm.updated_at desc,
        cbm.created_at desc,
        cbm.id desc
    ) as rn
  from public.campaign_batch_members cbm
  left join lateral (
    select
      mi.base_amount_cents,
      mi.paid_amount_cents,
      nullif(btrim(mi.payment_description), '') as payment_description,
      nullif(btrim(mi.payment_date_text), '') as payment_date_text
    from public.member_installments mi
    where mi.campaign_batch_member_id = cbm.id
      and btrim(mi.cod_parcela) = btrim(cbm.target_installment_id)
    order by mi.updated_at desc, mi.created_at desc, mi.id desc
    limit 1
  ) target on true
  where cbm.deleted_at is null
    and nullif(btrim(cbm.target_installment_id), '') is not null
), source as (
  select * from ranked where rn = 1
)
insert into public.member_target_installments(
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
  coalesce(source.target_base_amount_cents, source.installment_amount_cents, 0)::bigint,
  coalesce(source.target_paid_amount_cents, source.payment_amount_cents),
  case
    when source.payment_status = 'paid' then 0::bigint
    else coalesce(
      nullif(source.total_pending_amount_cents, 0),
      source.target_base_amount_cents,
      source.installment_amount_cents,
      0
    )::bigint
  end,
  source.payment_status,
  source.payment_status_source,
  source.target_payment_description,
  source.target_payment_date_text,
  case
    when source.last_erp_status_at is not null then 'erp'
    else 'import'
  end,
  source.last_erp_status_at,
  coalesce(source.last_erp_status_at, source.last_checked_at, source.updated_at, source.created_at),
  source.created_at,
  source.updated_at
from source
on conflict (member_id, external_installment_code) do nothing;

update public.campaign_batch_members cbm
set target_installment_ref_id = canonical.id,
    target_installment_id = canonical.external_installment_code
from public.member_target_installments canonical
where cbm.member_id = canonical.member_id
  and nullif(btrim(cbm.target_installment_id), '') is not null
  and btrim(cbm.target_installment_id) = canonical.external_installment_code
  and cbm.target_installment_ref_id is distinct from canonical.id;

-- Uma mesma parcela pode estar em varios lotes, mas apenas uma vez no mesmo lote.
do $$
begin
  if exists (
    select 1
    from public.campaign_batch_members cbm
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

create unique index if not exists idx_cbm_unique_batch_canonical_installment
  on public.campaign_batch_members(batch_id, target_installment_ref_id)
  where deleted_at is null and target_installment_ref_id is not null;

-- Vincula automaticamente novos registros ao canonico sem sobrescrever verdade ERP ja conhecida.
create or replace function public.bind_campaign_batch_member_target_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_target public.member_target_installments%rowtype;
begin
  v_code := nullif(btrim(new.target_installment_id), '');
  if v_code is null then
    return new;
  end if;

  new.target_installment_id := v_code;

  insert into public.member_target_installments(
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
    coalesce(new.installment_amount_cents, 0),
    new.payment_amount_cents,
    case
      when new.payment_status = 'paid' then 0
      else coalesce(nullif(new.total_pending_amount_cents, 0), new.installment_amount_cents, 0)
    end,
    new.payment_status,
    new.payment_status_source,
    'import',
    coalesce(new.last_erp_status_at, new.last_checked_at, new.updated_at, now())
  )
  on conflict (member_id, external_installment_code)
  do update set
    due_date_text = coalesce(public.member_target_installments.due_date_text, excluded.due_date_text),
    amount_cents = case
      when public.member_target_installments.last_erp_status_at is null
        then greatest(public.member_target_installments.amount_cents, excluded.amount_cents)
      else public.member_target_installments.amount_cents
    end,
    updated_at = now()
  returning * into v_target;

  new.target_installment_ref_id := v_target.id;

  -- Se ja existe verdade financeira, a importacao apenas cria o novo vinculo.
  if v_target.payment_status is not null or v_target.last_erp_status_at is not null then
    new.installment_amount_cents := v_target.amount_cents;
    new.payment_amount_cents := v_target.paid_amount_cents;
    new.total_pending_amount_cents := v_target.pending_amount_cents;
    new.payment_status := v_target.payment_status;
    new.payment_status_source := v_target.payment_status_source;
    new.last_erp_status_at := v_target.last_erp_status_at;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_bind_campaign_batch_member_target_v1
  on public.campaign_batch_members;
create trigger trg_bind_campaign_batch_member_target_v1
before insert or update of member_id, target_installment_id, target_installment_ref_id, due_date_text
on public.campaign_batch_members
for each row execute function public.bind_campaign_batch_member_target_v1();

-- Os triggers legados inferiam a verdade pelo snapshot de um unico vinculo.
-- A partir daqui a fonte de verdade e a parcela canonica.
drop trigger if exists trg_enforce_target_valor_financial_truth_v1
  on public.campaign_batch_members;
drop trigger if exists trg_normalize_target_explicit_payment_v2
  on public.campaign_batch_members;

create or replace function public.sync_target_installment_links_v1(p_target_installment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.member_target_installments%rowtype;
  v_batch record;
begin
  select * into v_target
  from public.member_target_installments
  where id = p_target_installment_id;

  if not found then
    return;
  end if;

  update public.campaign_batch_members cbm
  set installment_amount_cents = v_target.amount_cents,
      payment_amount_cents = v_target.paid_amount_cents,
      total_pending_amount_cents = v_target.pending_amount_cents,
      payment_status = v_target.payment_status,
      payment_status_source = v_target.payment_status_source,
      due_date_text = coalesce(v_target.due_date_text, cbm.due_date_text),
      last_erp_status_at = coalesce(v_target.last_erp_status_at, cbm.last_erp_status_at),
      processing_status = case
        when v_target.payment_status = 'paid' then 'completed'
        when cbm.payment_status = 'paid' and v_target.payment_status = 'unpaid' then 'pending'
        else cbm.processing_status
      end,
      next_check_at = case
        when v_target.payment_status = 'paid' then null
        when cbm.payment_status = 'paid' and v_target.payment_status = 'unpaid' then now()
        else cbm.next_check_at
      end,
      updated_at = now()
  where cbm.target_installment_ref_id = p_target_installment_id
    and cbm.deleted_at is null;

  if to_regprocedure('public.recalculate_batch_totals(uuid)') is not null then
    for v_batch in
      select distinct cbm.batch_id
      from public.campaign_batch_members cbm
      where cbm.target_installment_ref_id = p_target_installment_id
        and cbm.deleted_at is null
    loop
      perform public.recalculate_batch_totals(v_batch.batch_id);
    end loop;
  end if;
end;
$$;

revoke all on function public.sync_target_installment_links_v1(uuid)
  from public, anon, authenticated;
grant execute on function public.sync_target_installment_links_v1(uuid)
  to service_role;

-- Promove qualquer persistencia financeira existente no vinculo para o registro canonico.
-- old.claimed_at representa o instante de observacao mais fiel para evitar que uma resposta
-- iniciada antes sobrescreva uma consulta iniciada depois.
create or replace function public.capture_campaign_batch_member_financial_truth_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_observed_at timestamptz;
  v_description text;
  v_payment_date text;
  v_paid_amount bigint;
  v_base_amount bigint;
  v_updated boolean := false;
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
    nullif(btrim(mi.payment_description), ''),
    nullif(btrim(mi.payment_date_text), ''),
    mi.paid_amount_cents,
    mi.base_amount_cents
  into
    v_description,
    v_payment_date,
    v_paid_amount,
    v_base_amount
  from public.member_installments mi
  where mi.campaign_batch_member_id = new.id
    and btrim(mi.cod_parcela) = btrim(new.target_installment_id)
  order by mi.updated_at desc, mi.created_at desc, mi.id desc
  limit 1;

  update public.member_target_installments target
  set due_date_text = coalesce(new.due_date_text, target.due_date_text),
      amount_cents = coalesce(v_base_amount, new.installment_amount_cents, target.amount_cents, 0),
      paid_amount_cents = coalesce(v_paid_amount, new.payment_amount_cents),
      pending_amount_cents = case
        when new.payment_status = 'paid' then 0
        else coalesce(new.total_pending_amount_cents, new.installment_amount_cents, target.pending_amount_cents, 0)
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
    and (
      target.financial_observed_at is null
      or v_observed_at >= target.financial_observed_at
    );

  get diagnostics v_updated = row_count;
  if v_updated then
    perform public.sync_target_installment_links_v1(new.target_installment_ref_id);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_capture_campaign_batch_member_financial_truth_v1
  on public.campaign_batch_members;
create trigger trg_capture_campaign_batch_member_financial_truth_v1
after update of
  payment_status,
  payment_status_source,
  installment_amount_cents,
  payment_amount_cents,
  total_pending_amount_cents,
  last_erp_status_at
on public.campaign_batch_members
for each row execute function public.capture_campaign_batch_member_financial_truth_v1();

-- Mantem descricao/data do recebimento canonicos a partir do snapshot ERP.
create or replace function public.capture_member_installment_target_details_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_target_id uuid;
  v_target_code text;
begin
  if new.campaign_batch_member_id is null then
    return new;
  end if;

  select cbm.target_installment_ref_id, cbm.target_installment_id
    into v_target_id, v_target_code
  from public.campaign_batch_members cbm
  where cbm.id = new.campaign_batch_member_id;

  if v_target_id is null or btrim(coalesce(new.cod_parcela, '')) <> btrim(coalesce(v_target_code, '')) then
    return new;
  end if;

  update public.member_target_installments
  set payment_description = coalesce(nullif(btrim(new.payment_description), ''), payment_description),
      payment_date_text = coalesce(nullif(btrim(new.payment_date_text), ''), payment_date_text),
      paid_amount_cents = coalesce(new.paid_amount_cents, paid_amount_cents),
      amount_cents = case
        when new.base_amount_cents is not null then new.base_amount_cents
        else amount_cents
      end,
      updated_at = now()
  where id = v_target_id;

  return new;
end;
$$;

drop trigger if exists trg_capture_member_installment_target_details_v1
  on public.member_installments;
create trigger trg_capture_member_installment_target_details_v1
after insert or update of
  cod_parcela,
  payment_description,
  payment_date_text,
  paid_amount_cents,
  base_amount_cents
on public.member_installments
for each row execute function public.capture_member_installment_target_details_v1();

-- Mantem o contrato antigo da view para consumidores legados, mas a fonte financeira
-- deixa de ser um snapshot por lote e passa a ser a parcela canonica.
create or replace view public.target_installment_payment_v1
as
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
from public.campaign_batch_members cbm
join public.member_target_installments canonical
  on canonical.id = cbm.target_installment_ref_id
where cbm.deleted_at is null;

grant select on public.member_target_installments to service_role;
grant select on public.target_installment_payment_v1 to service_role;

-- Sincroniza todos os vinculos ja existentes com o canonico apos o backfill.
do $$
declare
  v_target record;
begin
  for v_target in
    select id from public.member_target_installments
  loop
    perform public.sync_target_installment_links_v1(v_target.id);
  end loop;
end;
$$;

comment on table public.member_target_installments is
  'Parcela financeira canonica: uma linha por associado + parcela, compartilhada por varios lotes/campanhas.';
comment on column public.campaign_batch_members.target_installment_ref_id is
  'Referencia a parcela financeira canonica; o vinculo continua representando apenas a participacao operacional no lote.';
