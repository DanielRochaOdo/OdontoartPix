-- 048: opt-in incremental projection ONLY for the grouped worker flush.
-- Keep 044/046 and 047 entry points unchanged. Install disabled.
do $admin$
begin
  if current_user = 'odontoart_pix_app' then
    raise exception 'Migration 048 requires the database administrator' using errcode='42501';
  end if;
end;
$admin$;

create table public.grouped_incremental_totals_state (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false
);
insert into public.grouped_incremental_totals_state values(true,false);

-- One request per grouped transaction, with batch row locks already held.
create table public.grouped_incremental_totals_pending (
  transaction_id bigint primary key,
  batch_ids uuid[] not null check(cardinality(batch_ids)>0)
);

create function public.project_grouped_incremental_totals_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,pg_temp as $$
begin
  if new.transaction_id <> txid_current()
    or not (select enabled from public.grouped_incremental_totals_state where singleton)
    or not (select enabled from public.batch_totals_shadow_state where singleton)
    or current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Invalid incremental projection transaction';
  end if;
  -- 047's deferred event is queued first. Fail closed if it did not finish.
  -- The 047 advisory xact lock is still held, and all batch rows were locked
  -- BEFORE the advisory lock. Never acquire additional source-row locks here.
  if exists(select 1 from public.batch_totals_shadow_transactions where transaction_id=new.transaction_id)
    or exists(select 1 from public.batch_totals_shadow_dirty where transaction_id=new.transaction_id)
    or exists(select 1 from public.grouped_batch_totals_pending where transaction_id=new.transaction_id) then
    raise exception 'Incremental projection requires completed shadow and grouped flush' using errcode='23514';
  end if;
  -- Check the actual lock, including for a request with no dirty source rows.
  if not exists (
    select 1 from pg_catalog.pg_locks
    where pid=pg_backend_pid() and locktype='advisory' and granted
      and database=(select oid from pg_catalog.pg_database where datname=current_database())
      and classid::bigint=(20261124047::bigint >> 32)
      and objid::bigint=(20261124047::bigint & 4294967295::bigint)
      and objsubid=1 and mode='ExclusiveLock'
  ) then
    raise exception 'Missing shadow serialization lock' using errcode='23514';
  end if;

  -- 044 status precedence and integer casts. Missing shadow row means empty
  -- batch, not a missing canonical installment (which still contributes 1).
  with expected as (
    select b.id,
      coalesce(s.total_records,0)::int as total_records,
      coalesce(s.processed_records,0)::int as processed_records,
      coalesce(s.paid_records,0)::int as paid_records,
      coalesce(s.unpaid_records,0)::int as unpaid_records,
      coalesce(s.error_records,0)::int as error_records,
      coalesce(s.total_pending_amount_cents,0)::bigint as total_pending_amount_cents,
      coalesce(s.total_amount_cents,0)::bigint as total_amount_cents,
      case when s.processing_records>0 then 'processando'
           when s.waiting_records>0 then 'aguardando'
           when s.error_records>0 then 'concluido_com_erros'
           when s.total_records>0 and s.processed_records=s.total_records then 'concluido'
           else 'aguardando' end as status
    from public.campaign_batches b
    left join public.batch_totals_shadow_totals s on s.batch_id=b.id
    where b.id=any(new.batch_ids)
  )
  update public.campaign_batches b set
    total_records=e.total_records, processed_records=e.processed_records,
    paid_records=e.paid_records, unpaid_records=e.unpaid_records,
    error_records=e.error_records, total_pending_amount_cents=e.total_pending_amount_cents,
    total_amount_cents=e.total_amount_cents, status=e.status, updated_at=now()
  from expected e where b.id=e.id
    and row(b.total_records,b.processed_records,b.paid_records,b.unpaid_records,b.error_records,
      b.total_pending_amount_cents,b.total_amount_cents,b.status)
    is distinct from row(e.total_records,e.processed_records,e.paid_records,e.unpaid_records,e.error_records,
      e.total_pending_amount_cents,e.total_amount_cents,e.status);

  delete from public.grouped_incremental_totals_pending where transaction_id=new.transaction_id;
  return null;
end;
$$;

create constraint trigger grouped_incremental_totals_project_at_commit
after insert on public.grouped_incremental_totals_pending
deferrable initially deferred for each row
execute function public.project_grouped_incremental_totals_v1();

-- Private helper: called only by v2 at the END of the grouped transaction.
-- If disabled, return false and let the invoker execute the unchanged 046.
create function public.try_grouped_incremental_totals_v1()
returns boolean language plpgsql security definer
set search_path=pg_catalog,pg_temp as $$
declare
  v_tx bigint := txid_current();
  v_ids uuid[];
begin
  if not (select enabled from public.grouped_incremental_totals_state where singleton) then
    return false;
  end if;
  if current_setting('odontoart.grouped_batch_totals',true) is distinct from 'on'
    or current_setting('transaction_isolation') <> 'read committed'
    or not (select enabled from public.batch_totals_shadow_state where singleton) then
    raise exception 'Invalid grouped incremental flush';
  end if;
  if exists(select 1 from public.grouped_incremental_totals_pending where transaction_id=v_tx) then
    raise exception 'Grouped incremental flush may only be called once per transaction';
  end if;
  select array_agg(batch_id order by batch_id) into v_ids
    from public.grouped_batch_totals_pending where transaction_id=v_tx;
  perform set_config('odontoart.grouped_batch_totals','off',true);
  if coalesce(cardinality(v_ids),0)=0 then return true; end if;

  -- Same sorted locks as 044, BEFORE the deferred 047 serialization lock.
  -- No waiting for a batch row while holding the advisory lock.
  perform b.id from public.campaign_batches b where b.id=any(v_ids)
    order by b.id for no key update of b;
  -- Ensure a 047 event even when canonical and link contributions did not
  -- change (explicit repair of a stale official total must still work).
  insert into public.batch_totals_shadow_transactions(transaction_id)
    values(v_tx) on conflict do nothing;
  delete from public.grouped_batch_totals_pending where transaction_id=v_tx;
  insert into public.grouped_incremental_totals_pending values(v_tx,v_ids);
  return true;
end;
$$;

create function public.flush_grouped_batch_totals_v2()
returns void language plpgsql volatile
set search_path=pg_catalog,pg_temp as $$
begin
  if not public.try_grouped_incremental_totals_v1() then
    perform public.flush_grouped_batch_totals_v1();
  end if;
end;
$$;

-- Prevent 047 teardown/rebuild underneath an enabled 048.
create function public.guard_grouped_incremental_shadow_state_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,pg_temp as $$
begin
  if (select enabled from public.grouped_incremental_totals_state where singleton) then
    raise exception 'Disable grouped incremental totals before changing shadow state';
  end if;
  return new;
end;
$$;
create trigger trg_guard_grouped_incremental_shadow_state
before update on public.batch_totals_shadow_state
for each row execute function public.guard_grouped_incremental_shadow_state_v1();

-- Admin-only maintenance. Requires drained writers. The 047 shadow stays
-- active after rollback, unless it was already disabled.
create function public.set_grouped_incremental_totals_v1(p_enabled boolean)
returns void language plpgsql
set search_path=pg_catalog,pg_temp as $$
declare
  v_ids uuid[];
begin
  if p_enabled is null or current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Invalid incremental maintenance request';
  end if;
  lock table public.campaign_batches,public.campaign_batch_members,public.member_target_installments
    in share row exclusive mode nowait;
  if not pg_try_advisory_xact_lock(20261124047::bigint) then
    raise exception 'Shadow flush active; abort maintenance' using errcode='55P03';
  end if;
  if exists(select 1 from public.grouped_incremental_totals_pending)
    or exists(select 1 from public.grouped_batch_totals_pending)
    or exists(select 1 from public.batch_totals_shadow_transactions)
    or exists(select 1 from public.batch_totals_shadow_dirty) then
    raise exception 'Pending totals work; abort maintenance';
  end if;
  if p_enabled then
    if not (select enabled from public.batch_totals_shadow_state where singleton)
      or exists(select 1 from public.batch_totals_shadow_audit_v1 where shadow_differs or official_differs or orphan_batch)
      or exists(select 1 from public.batch_totals_shadow_link_audit_v1 where differs or orphan_contribution or missing_contribution) then
      raise exception 'Shadow must be enabled and fully reconciled before promotion';
    end if;
    update public.grouped_incremental_totals_state set enabled=true where singleton;
  else
    update public.grouped_incremental_totals_state set enabled=false where singleton;
    if (select enabled from public.batch_totals_shadow_state where singleton) then
      perform public.set_batch_totals_shadow_v1(true);
    end if;
    select array_agg(id order by id) into v_ids from public.campaign_batches;
    -- 044 uses unqualified relations. Explicitly set its trusted search path.
    perform set_config('search_path','pg_catalog,public,pg_temp',true);
    perform public.recalculate_batch_totals_many(v_ids);
    if exists(select 1 from public.batch_totals_shadow_audit_v1 where official_differs or orphan_batch)
      or ((select enabled from public.batch_totals_shadow_state where singleton)
        and (exists(select 1 from public.batch_totals_shadow_audit_v1 where shadow_differs)
          or exists(select 1 from public.batch_totals_shadow_link_audit_v1 where differs or orphan_contribution or missing_contribution))) then
      raise exception 'Rollback reconciliation failed';
    end if;
  end if;
end;
$$;

revoke all on public.grouped_incremental_totals_state,public.grouped_incremental_totals_pending from public;
revoke all on function public.project_grouped_incremental_totals_v1(),
  public.try_grouped_incremental_totals_v1(),public.flush_grouped_batch_totals_v2(),
  public.guard_grouped_incremental_shadow_state_v1(),public.set_grouped_incremental_totals_v1(boolean) from public;
do $admin$
begin
  if exists(select 1 from pg_roles where rolname='odontoart_pix_app') then
    revoke all on public.grouped_incremental_totals_state,public.grouped_incremental_totals_pending from odontoart_pix_app;
    revoke all on function public.project_grouped_incremental_totals_v1(),
      public.guard_grouped_incremental_shadow_state_v1(),public.set_grouped_incremental_totals_v1(boolean) from odontoart_pix_app;
    grant execute on function public.try_grouped_incremental_totals_v1(),public.flush_grouped_batch_totals_v2() to odontoart_pix_app;
    if has_table_privilege('odontoart_pix_app','public.grouped_incremental_totals_state','INSERT,UPDATE,DELETE,TRUNCATE')
      or has_table_privilege('odontoart_pix_app','public.grouped_incremental_totals_pending','INSERT,UPDATE,DELETE,TRUNCATE')
      or has_function_privilege('odontoart_pix_app','public.set_grouped_incremental_totals_v1(boolean)','EXECUTE') then
      raise exception 'Application inherits incremental administrative privileges' using errcode='42501';
    end if;
  end if;
end;
$admin$;

insert into public.schema_migrations(version,name)
values(48,'grouped_incremental_batch_totals_pilot') on conflict(version) do nothing;
