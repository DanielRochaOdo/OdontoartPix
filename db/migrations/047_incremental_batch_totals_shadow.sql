-- 047: experimental shadow only. Never writes campaign_batches or financial truth.
-- Default disabled; administrator must rebuild under a controlled idle window.
-- The runtime app must not own SECURITY DEFINER functions or private state.
do $
begin
  if current_user = 'odontoart_pix_app' then
    raise exception 'Migration 047 must be applied by the database administrator, not the app role'
      using errcode = '42501';
  end if;
end;
$;

create table public.batch_totals_shadow_state (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false
);
insert into public.batch_totals_shadow_state(singleton, enabled) values (true, false);

-- No source FKs: the old contribution must survive source cascades until flush.
-- Rows are removed by the transactional reconciliation, not by cascade order.
create table public.batch_totals_shadow_contributions (
  member_link_id uuid primary key,
  batch_id uuid not null,
  total_records bigint not null check (total_records >= 0),
  processed_records bigint not null check (processed_records >= 0),
  paid_records bigint not null check (paid_records >= 0),
  unpaid_records bigint not null check (unpaid_records >= 0),
  error_records bigint not null check (error_records >= 0),
  processing_records bigint not null check (processing_records >= 0),
  waiting_records bigint not null check (waiting_records >= 0),
  total_amount_cents bigint not null check (total_amount_cents >= 0),
  total_pending_amount_cents bigint not null check (total_pending_amount_cents >= 0)
);
create table public.batch_totals_shadow_totals (
  batch_id uuid primary key,
  total_records bigint not null check (total_records >= 0),
  processed_records bigint not null check (processed_records >= 0),
  paid_records bigint not null check (paid_records >= 0),
  unpaid_records bigint not null check (unpaid_records >= 0),
  error_records bigint not null check (error_records >= 0),
  processing_records bigint not null check (processing_records >= 0),
  waiting_records bigint not null check (waiting_records >= 0),
  total_amount_cents bigint not null check (total_amount_cents >= 0),
  total_pending_amount_cents bigint not null check (total_pending_amount_cents >= 0)
);
create table public.batch_totals_shadow_dirty (
  transaction_id bigint not null,
  kind text not null check (kind in ('link','target')),
  entity_id uuid not null,
  primary key (transaction_id, kind, entity_id)
);
create table public.batch_totals_shadow_transactions (
  transaction_id bigint primary key
);

-- Contribution semantics match 044, including NULL canonical and terminal states.
create view public.batch_totals_shadow_current_v1 as
select cbm.id as member_link_id, cbm.batch_id,
       1::bigint as total_records,
       (case when cbm.processing_status = 'completed' then 1 else 0 end)::bigint as processed_records,
       (case when t.payment_status = 'paid' then 1 else 0 end)::bigint as paid_records,
       (case when t.payment_status = 'unpaid' then 1 else 0 end)::bigint as unpaid_records,
       (case when cbm.processing_status = 'error' and
          (t.payment_status is null or t.payment_status not in ('paid','agreed','excluded')) then 1 else 0 end)::bigint as error_records,
       (case when cbm.processing_status = 'processing' then 1 else 0 end)::bigint as processing_records,
       (case when cbm.processing_status in ('pending','queued','retrying','aguardando') and
          (t.payment_status is null or t.payment_status not in ('paid','agreed','excluded')) then 1 else 0 end)::bigint as waiting_records,
       coalesce(t.amount_cents,0)::bigint as total_amount_cents,
       coalesce(t.pending_amount_cents,0)::bigint as total_pending_amount_cents
from public.campaign_batch_members cbm
left join public.member_target_installments t on t.id = cbm.target_installment_ref_id
where cbm.deleted_at is null;

create function public.batch_totals_shadow_mark_v1(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not (select enabled from public.batch_totals_shadow_state where singleton) then return; end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Shadow totals require READ COMMITTED' using errcode = '0A000';
  end if;
  insert into public.batch_totals_shadow_dirty(transaction_id, kind, entity_id)
    values(txid_current(), p_kind, p_id) on conflict do nothing;
  insert into public.batch_totals_shadow_transactions(transaction_id)
    values(txid_current()) on conflict do nothing;
end;
$$;

create function public.batch_totals_shadow_capture_link_v1()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    -- BEFORE triggers may change relevant values even if the SET list did not.
    if row(old.id,old.batch_id,old.target_installment_ref_id,old.deleted_at,old.processing_status)
       is not distinct from row(new.id,new.batch_id,new.target_installment_ref_id,new.deleted_at,new.processing_status) then
      return null;
    end if;
    perform public.batch_totals_shadow_mark_v1('link',old.id);
    if old.id is distinct from new.id then
      perform public.batch_totals_shadow_mark_v1('link',new.id);
    end if;
  elsif tg_op = 'INSERT' then
    perform public.batch_totals_shadow_mark_v1('link',new.id);
  else
    perform public.batch_totals_shadow_mark_v1('link',old.id);
  end if;
  return null;
end;
$$;

create function public.batch_totals_shadow_capture_target_v1()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    if row(old.id,old.amount_cents,old.pending_amount_cents,old.payment_status)
       is not distinct from row(new.id,new.amount_cents,new.pending_amount_cents,new.payment_status) then
      return null;
    end if;
    perform public.batch_totals_shadow_mark_v1('target',old.id);
    if old.id is distinct from new.id then
      perform public.batch_totals_shadow_mark_v1('target',new.id);
    end if;
  elsif tg_op = 'INSERT' then
    perform public.batch_totals_shadow_mark_v1('target',new.id);
  else
    perform public.batch_totals_shadow_mark_v1('target',old.id);
  end if;
  return null;
end;
$$;

create function public.batch_totals_shadow_flush_v1()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_tx bigint := new.transaction_id;
  v_links uuid[];
begin
  if v_tx <> txid_current() then raise exception 'Shadow transaction mismatch'; end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Shadow totals require READ COMMITTED' using errcode = '0A000';
  end if;
  -- Serialize shadow writes only. No source-row locks or official totals writes.
  -- Fresh READ COMMITTED statements after this lock observe prior shadow commits.
  perform pg_advisory_xact_lock(20261124047::bigint);
  if not exists (select 1 from public.batch_totals_shadow_transactions where transaction_id = v_tx) then
    return null;
  end if;
  select array_agg(id order by id) into v_links from (
    select entity_id as id from public.batch_totals_shadow_dirty
      where transaction_id = v_tx and kind = 'link'
    union
    select cbm.id from public.batch_totals_shadow_dirty d
      join public.campaign_batch_members cbm on cbm.target_installment_ref_id = d.entity_id
       and cbm.deleted_at is null
      where d.transaction_id = v_tx and d.kind = 'target'
  ) affected;

  -- Old contributions stay available for deletes and moves. The UNION ALL
  -- subtracts prior values and adds final values, then nets by batch.
  with changes as (
    select batch_id, -total_records as total_records, -processed_records as processed_records, -paid_records as paid_records, -unpaid_records as unpaid_records, -error_records as error_records, -processing_records as processing_records, -waiting_records as waiting_records, -total_amount_cents as total_amount_cents, -total_pending_amount_cents as total_pending_amount_cents
      from public.batch_totals_shadow_contributions where member_link_id = any(v_links)
    union all
    select batch_id, total_records, processed_records, paid_records, unpaid_records, error_records, processing_records, waiting_records, total_amount_cents, total_pending_amount_cents
      from public.batch_totals_shadow_current_v1 where member_link_id = any(v_links)
  ), delta as (
    select batch_id, sum(total_records)::bigint as total_records,
           sum(processed_records)::bigint as processed_records,
           sum(paid_records)::bigint as paid_records,
           sum(unpaid_records)::bigint as unpaid_records,
           sum(error_records)::bigint as error_records,
           sum(processing_records)::bigint as processing_records,
           sum(waiting_records)::bigint as waiting_records,
           sum(total_amount_cents)::bigint as total_amount_cents,
           sum(total_pending_amount_cents)::bigint as total_pending_amount_cents
      from changes group by batch_id
  )
  insert into public.batch_totals_shadow_totals(batch_id, total_records, processed_records, paid_records, unpaid_records, error_records, processing_records, waiting_records, total_amount_cents, total_pending_amount_cents)
    select d.batch_id, coalesce(s.total_records,0) + d.total_records,
           coalesce(s.processed_records,0) + d.processed_records,
           coalesce(s.paid_records,0) + d.paid_records,
           coalesce(s.unpaid_records,0) + d.unpaid_records,
           coalesce(s.error_records,0) + d.error_records,
           coalesce(s.processing_records,0) + d.processing_records,
           coalesce(s.waiting_records,0) + d.waiting_records,
           coalesce(s.total_amount_cents,0) + d.total_amount_cents,
           coalesce(s.total_pending_amount_cents,0) + d.total_pending_amount_cents
    from delta d left join public.batch_totals_shadow_totals s on s.batch_id = d.batch_id
    where d.total_records <> 0 or d.processed_records <> 0 or d.paid_records <> 0 or d.unpaid_records <> 0 or d.error_records <> 0 or d.processing_records <> 0 or d.waiting_records <> 0 or d.total_amount_cents <> 0 or d.total_pending_amount_cents <> 0
  on conflict (batch_id) do update set
      total_records = excluded.total_records,
      processed_records = excluded.processed_records,
      paid_records = excluded.paid_records,
      unpaid_records = excluded.unpaid_records,
      error_records = excluded.error_records,
      processing_records = excluded.processing_records,
      waiting_records = excluded.waiting_records,
      total_amount_cents = excluded.total_amount_cents,
      total_pending_amount_cents = excluded.total_pending_amount_cents;

  delete from public.batch_totals_shadow_contributions s
    where s.member_link_id = any(v_links)
      and not exists (select 1 from public.batch_totals_shadow_current_v1 c where c.member_link_id = s.member_link_id);
  insert into public.batch_totals_shadow_contributions as s(member_link_id, batch_id, total_records, processed_records, paid_records, unpaid_records, error_records, processing_records, waiting_records, total_amount_cents, total_pending_amount_cents)
    select member_link_id, batch_id, total_records, processed_records, paid_records, unpaid_records, error_records, processing_records, waiting_records, total_amount_cents, total_pending_amount_cents
      from public.batch_totals_shadow_current_v1 where member_link_id = any(v_links)
  on conflict (member_link_id) do update set batch_id = excluded.batch_id,
      total_records = excluded.total_records,
      processed_records = excluded.processed_records,
      paid_records = excluded.paid_records,
      unpaid_records = excluded.unpaid_records,
      error_records = excluded.error_records,
      processing_records = excluded.processing_records,
      waiting_records = excluded.waiting_records,
      total_amount_cents = excluded.total_amount_cents,
      total_pending_amount_cents = excluded.total_pending_amount_cents
  where row(s.batch_id, s.total_records, s.processed_records, s.paid_records, s.unpaid_records, s.error_records, s.processing_records, s.waiting_records, s.total_amount_cents, s.total_pending_amount_cents) is distinct from row(excluded.batch_id, excluded.total_records, excluded.processed_records, excluded.paid_records, excluded.unpaid_records, excluded.error_records, excluded.processing_records, excluded.waiting_records, excluded.total_amount_cents, excluded.total_pending_amount_cents);

  delete from public.batch_totals_shadow_totals where total_records = 0
    and processed_records = 0 and paid_records = 0 and unpaid_records = 0 and error_records = 0 and processing_records = 0 and waiting_records = 0 and total_amount_cents = 0 and total_pending_amount_cents = 0;
  delete from public.batch_totals_shadow_dirty where transaction_id = v_tx;
  delete from public.batch_totals_shadow_transactions where transaction_id = v_tx;
  return null;
end;
$$;

create constraint trigger batch_totals_shadow_flush_at_commit
after insert on public.batch_totals_shadow_transactions
deferrable initially deferred for each row
execute function public.batch_totals_shadow_flush_v1();

create trigger trg_batch_totals_shadow_link
after insert or update or delete on public.campaign_batch_members
for each row execute function public.batch_totals_shadow_capture_link_v1();

create trigger trg_batch_totals_shadow_target
after insert or update or delete on public.member_target_installments
for each row execute function public.batch_totals_shadow_capture_target_v1();

-- TRUNCATE does not fire row triggers. Fail closed while tracking.
create function public.batch_totals_shadow_guard_truncate_v1()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if (select enabled from public.batch_totals_shadow_state where singleton) then
    raise exception 'Disable and rebuild shadow totals before TRUNCATE' using errcode = '0A000';
  end if;
  return null;
end;
$$;
create trigger trg_batch_totals_shadow_link_truncate before truncate on public.campaign_batch_members
for each statement execute function public.batch_totals_shadow_guard_truncate_v1();
create trigger trg_batch_totals_shadow_target_truncate before truncate on public.member_target_installments
for each statement execute function public.batch_totals_shadow_guard_truncate_v1();

-- Admin-only maintenance: no active writers, NOWAIT, rebuild from canonical.
-- Disable clears the derived data; never changes source or official totals.
create function public.set_batch_totals_shadow_v1(p_enabled boolean)
returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if p_enabled is null or current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Invalid shadow maintenance request';
  end if;
  lock table public.campaign_batches, public.campaign_batch_members, public.member_target_installments
    in share row exclusive mode nowait;
  perform pg_advisory_xact_lock(20261124047::bigint);
  if exists (select 1 from public.batch_totals_shadow_transactions)
     or exists (select 1 from public.batch_totals_shadow_dirty) then
    raise exception 'Unflushed shadow work; abort maintenance';
  end if;
  update public.batch_totals_shadow_state set enabled = false where singleton;
  delete from public.batch_totals_shadow_contributions;
  delete from public.batch_totals_shadow_totals;
  if p_enabled then
    insert into public.batch_totals_shadow_contributions select * from public.batch_totals_shadow_current_v1;
    insert into public.batch_totals_shadow_totals(batch_id, total_records, processed_records, paid_records, unpaid_records, error_records, processing_records, waiting_records, total_amount_cents, total_pending_amount_cents)
      select batch_id, sum(total_records)::bigint as total_records,
           sum(processed_records)::bigint as processed_records,
           sum(paid_records)::bigint as paid_records,
           sum(unpaid_records)::bigint as unpaid_records,
           sum(error_records)::bigint as error_records,
           sum(processing_records)::bigint as processing_records,
           sum(waiting_records)::bigint as waiting_records,
           sum(total_amount_cents)::bigint as total_amount_cents,
           sum(total_pending_amount_cents)::bigint as total_pending_amount_cents from public.batch_totals_shadow_contributions group by batch_id;
    update public.batch_totals_shadow_state set enabled = true where singleton;
  end if;
end;
$$;

-- Independent full aggregate, NOT derived from the contribution view.
create view public.batch_totals_shadow_audit_v1 as
with full_calc as (
  select cbm.batch_id,
    count(*)::bigint as total_records,
    count(*) filter (where cbm.processing_status='completed') as processed_records,
    count(*) filter (where t.payment_status='paid') as paid_records,
    count(*) filter (where t.payment_status='unpaid') as unpaid_records,
    count(*) filter (where cbm.processing_status='error' and
      (t.payment_status is null or t.payment_status not in ('paid','agreed','excluded'))) as error_records,
    count(*) filter (where cbm.processing_status='processing') as processing_records,
    count(*) filter (where cbm.processing_status in ('pending','queued','retrying','aguardando') and
      (t.payment_status is null or t.payment_status not in ('paid','agreed','excluded'))) as waiting_records,
    coalesce(sum(t.amount_cents),0)::bigint as total_amount_cents,
    coalesce(sum(t.pending_amount_cents),0)::bigint as total_pending_amount_cents
  from public.campaign_batch_members cbm left join public.member_target_installments t
    on t.id=cbm.target_installment_ref_id where cbm.deleted_at is null group by cbm.batch_id
), ids as (
  select id as batch_id from public.campaign_batches
  union select batch_id from public.batch_totals_shadow_totals
  union select batch_id from full_calc
)
select ids.batch_id, state.enabled,
  (b.id is null) as orphan_batch,
  row(coalesce(s.total_records,0), coalesce(s.processed_records,0), coalesce(s.paid_records,0), coalesce(s.unpaid_records,0), coalesce(s.error_records,0), coalesce(s.processing_records,0), coalesce(s.waiting_records,0), coalesce(s.total_amount_cents,0), coalesce(s.total_pending_amount_cents,0))
    is distinct from row(coalesce(f.total_records,0), coalesce(f.processed_records,0), coalesce(f.paid_records,0), coalesce(f.unpaid_records,0), coalesce(f.error_records,0), coalesce(f.processing_records,0), coalesce(f.waiting_records,0), coalesce(f.total_amount_cents,0), coalesce(f.total_pending_amount_cents,0)) as shadow_differs,
  row(b.total_records,b.processed_records,b.paid_records,b.unpaid_records,b.error_records,
      b.total_amount_cents,b.total_pending_amount_cents,b.status::text)
    is distinct from row(coalesce(f.total_records,0),coalesce(f.processed_records,0),coalesce(f.paid_records,0),
      coalesce(f.unpaid_records,0),coalesce(f.error_records,0),coalesce(f.total_amount_cents,0),
      coalesce(f.total_pending_amount_cents,0),case when f.processing_records > 0 then 'processando'
       when f.waiting_records > 0 then 'aguardando'
       when f.error_records > 0 then 'concluido_com_erros'
       when f.total_records > 0 and f.processed_records = f.total_records then 'concluido'
       else 'aguardando' end) as official_differs,
  case when s.processing_records > 0 then 'processando'
       when s.waiting_records > 0 then 'aguardando'
       when s.error_records > 0 then 'concluido_com_erros'
       when s.total_records > 0 and s.processed_records = s.total_records then 'concluido'
       else 'aguardando' end as shadow_status,
  case when f.processing_records > 0 then 'processando'
       when f.waiting_records > 0 then 'aguardando'
       when f.error_records > 0 then 'concluido_com_erros'
       when f.total_records > 0 and f.processed_records = f.total_records then 'concluido'
       else 'aguardando' end as expected_status
from ids cross join public.batch_totals_shadow_state state
left join public.campaign_batches b on b.id=ids.batch_id
left join full_calc f on f.batch_id=ids.batch_id
left join public.batch_totals_shadow_totals s on s.batch_id=ids.batch_id;

-- Per-link parity prevents offsetting errors from hiding in batch sums.
create view public.batch_totals_shadow_link_audit_v1 as
with expected as (
  select cbm.id as member_link_id, cbm.batch_id,
    1::bigint as total_records,
    count(*) filter (where cbm.processing_status='completed') as processed_records,
    count(*) filter (where t.payment_status='paid') as paid_records,
    count(*) filter (where t.payment_status='unpaid') as unpaid_records,
    count(*) filter (where cbm.processing_status='error' and
      (t.payment_status is null or t.payment_status not in ('paid','agreed','excluded'))) as error_records,
    count(*) filter (where cbm.processing_status='processing') as processing_records,
    count(*) filter (where cbm.processing_status in ('pending','queued','retrying','aguardando') and
      (t.payment_status is null or t.payment_status not in ('paid','agreed','excluded'))) as waiting_records,
    coalesce(sum(t.amount_cents),0)::bigint as total_amount_cents,
    coalesce(sum(t.pending_amount_cents),0)::bigint as total_pending_amount_cents
  from public.campaign_batch_members cbm left join public.member_target_installments t
    on t.id=cbm.target_installment_ref_id where cbm.deleted_at is null group by cbm.id,cbm.batch_id
)
select coalesce(e.member_link_id,s.member_link_id) as member_link_id,
  coalesce(e.batch_id,s.batch_id) as batch_id, state.enabled,
  (e.member_link_id is null) as orphan_contribution,
  (s.member_link_id is null) as missing_contribution,
  row(e.batch_id,e.total_records,e.processed_records,e.paid_records,e.unpaid_records,
      e.error_records,e.processing_records,e.waiting_records,e.total_amount_cents,e.total_pending_amount_cents)
    is distinct from row(s.batch_id,s.total_records,s.processed_records,s.paid_records,s.unpaid_records,
      s.error_records,s.processing_records,s.waiting_records,s.total_amount_cents,s.total_pending_amount_cents) as differs
from expected e full join public.batch_totals_shadow_contributions s using (member_link_id)
cross join public.batch_totals_shadow_state state;

-- No public access to implementation or admin activation. Trigger functions
-- run with the migration owner's permissions, using only qualified objects.
revoke all on function public.batch_totals_shadow_mark_v1(text,uuid),
  public.batch_totals_shadow_capture_link_v1(), public.batch_totals_shadow_capture_target_v1(),
  public.batch_totals_shadow_flush_v1(), public.batch_totals_shadow_guard_truncate_v1(),
  public.set_batch_totals_shadow_v1(boolean) from public;
revoke all on public.batch_totals_shadow_state, public.batch_totals_shadow_contributions,
  public.batch_totals_shadow_totals, public.batch_totals_shadow_dirty,
  public.batch_totals_shadow_transactions, public.batch_totals_shadow_current_v1,
  public.batch_totals_shadow_audit_v1, public.batch_totals_shadow_link_audit_v1 from public;

-- Production may grant privileges to the app via ALTER DEFAULT PRIVILEGES.
do $
begin
  if exists (select 1 from pg_roles where rolname = 'odontoart_pix_app') then
    revoke all on public.batch_totals_shadow_state, public.batch_totals_shadow_contributions,
      public.batch_totals_shadow_totals, public.batch_totals_shadow_dirty,
      public.batch_totals_shadow_transactions, public.batch_totals_shadow_current_v1,
      public.batch_totals_shadow_audit_v1, public.batch_totals_shadow_link_audit_v1 from odontoart_pix_app;
    revoke all on function public.batch_totals_shadow_mark_v1(text,uuid),
      public.batch_totals_shadow_capture_link_v1(), public.batch_totals_shadow_capture_target_v1(),
      public.batch_totals_shadow_flush_v1(), public.batch_totals_shadow_guard_truncate_v1(),
      public.set_batch_totals_shadow_v1(boolean) from odontoart_pix_app;
    -- Catch inherited write/activation privileges, not only direct grants.
    if exists (
      select 1 from unnest(array[
        'public.batch_totals_shadow_state', 'public.batch_totals_shadow_contributions',
        'public.batch_totals_shadow_totals', 'public.batch_totals_shadow_dirty',
        'public.batch_totals_shadow_transactions'
      ]) as objects(name)
      where has_table_privilege('odontoart_pix_app', objects.name, 'INSERT,UPDATE,DELETE,TRUNCATE')
    ) or has_function_privilege('odontoart_pix_app','public.set_batch_totals_shadow_v1(boolean)','EXECUTE')
      or has_function_privilege('odontoart_pix_app','public.batch_totals_shadow_mark_v1(text,uuid)','EXECUTE') then
      raise exception 'App inherits shadow administrative privileges; review role memberships'
        using errcode = '42501';
    end if;
  end if;
end;
$;

insert into public.schema_migrations(version,name)
values (47,'incremental_batch_totals_shadow') on conflict(version) do nothing;
