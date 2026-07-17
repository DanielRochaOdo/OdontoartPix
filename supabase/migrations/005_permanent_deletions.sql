create table if not exists deletion_audit_logs (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,
  requested_by uuid references profiles(id),
  campaign_id uuid,
  batch_id uuid,
  resource_name text,
  removed_count integer not null default 0,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table if exists campaign_batch_members
  drop constraint if exists campaign_batch_members_member_id_fkey;

alter table if exists campaign_batch_members
  add constraint campaign_batch_members_member_id_fkey
  foreign key (member_id) references members(id) on delete restrict;

create or replace function recalculate_campaign_totals(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update campaigns c
  set
    total_batches = coalesce(stats.total_batches, 0),
    total_members = coalesce(stats.total_members, 0),
    processed_members = coalesce(stats.processed_members, 0),
    pending_members = coalesce(stats.pending_members, 0),
    paid_members = coalesce(stats.paid_members, 0),
    unpaid_members = coalesce(stats.unpaid_members, 0),
    error_members = coalesce(stats.error_members, 0),
    total_pending_amount_cents = coalesce(stats.total_pending_amount_cents, 0),
    progress_percent = coalesce(stats.progress_percent, 0),
    success_percent = coalesce(stats.success_percent, 0),
    updated_at = now()
  from (
    select
      count(distinct cb.id)::int as total_batches,
      count(cbm.id)::int as total_members,
      count(*) filter (where cbm.processing_status in ('completed', 'paid', 'unpaid'))::int as processed_members,
      count(*) filter (where cbm.processing_status = 'pendente')::int as pending_members,
      count(*) filter (where cbm.payment_status = 'paid')::int as paid_members,
      count(*) filter (where cbm.payment_status = 'unpaid')::int as unpaid_members,
      count(*) filter (where cbm.processing_status = 'error')::int as error_members,
      coalesce(sum(cbm.total_pending_amount_cents), 0)::int as total_pending_amount_cents,
      case
        when count(cbm.id) = 0 then 0
        else round((count(*) filter (where cbm.processing_status in ('completed', 'paid', 'unpaid'))::numeric / count(cbm.id)::numeric) * 100, 2)
      end as progress_percent,
      case
        when count(cbm.id) = 0 then 0
        else round((count(*) filter (where cbm.payment_status = 'paid')::numeric / count(cbm.id)::numeric) * 100, 2)
      end as success_percent
    from campaign_batches cb
    left join campaign_batch_members cbm on cbm.batch_id = cb.id
    where cb.campaign_id = p_campaign_id
      and cb.deleted_at is null
      and cbm.deleted_at is null
  ) stats
  where c.id = p_campaign_id;
end;
$$;

create or replace function delete_batch_permanently(
  p_batch_id uuid,
  p_requested_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_batch_name text;
  v_member_ids uuid[];
  v_batch_members_deleted int := 0;
  v_installments_deleted int := 0;
  v_plan_totals_deleted int := 0;
  v_consultation_logs_deleted int := 0;
  v_jobs_deleted int := 0;
  v_orphan_members_deleted int := 0;
begin
  select cb.campaign_id, cb.name
    into v_campaign_id, v_batch_name
  from campaign_batches cb
  where cb.id = p_batch_id;

  if not found then
    raise exception 'batch_not_found';
  end if;

  select array_agg(cbm.member_id)
    into v_member_ids
  from campaign_batch_members cbm
  where cbm.batch_id = p_batch_id;

  if exists (
    select 1 from processing_jobs pj
    where pj.batch_id = p_batch_id and pj.status = 'running'
  ) then
    raise exception 'batch_running';
  end if;

  insert into deletion_audit_logs(action_type, requested_by, campaign_id, batch_id, resource_name, removed_count, details)
  values ('batch_delete', p_requested_by, v_campaign_id, p_batch_id, v_batch_name, coalesce(array_length(v_member_ids, 1), 0), jsonb_build_object('member_ids_count', coalesce(array_length(v_member_ids, 1), 0)));

  delete from member_installments mi
  using campaign_batch_members cbm
  where mi.campaign_batch_member_id = cbm.id
    and cbm.batch_id = p_batch_id
  ;
  get diagnostics v_installments_deleted = row_count;

  delete from member_plan_totals mpt
  using campaign_batch_members cbm
  where mpt.campaign_batch_member_id = cbm.id
    and cbm.batch_id = p_batch_id
  ;
  get diagnostics v_plan_totals_deleted = row_count;

  delete from consultation_logs cl
  using campaign_batch_members cbm
  where cl.campaign_batch_member_id = cbm.id
    and cbm.batch_id = p_batch_id
  ;
  get diagnostics v_consultation_logs_deleted = row_count;

  delete from processing_jobs pj
  where pj.batch_id = p_batch_id;
  get diagnostics v_jobs_deleted = row_count;

  delete from campaign_batch_members
  where batch_id = p_batch_id;
  get diagnostics v_batch_members_deleted = row_count;

  delete from campaign_batches
  where id = p_batch_id;

  delete from members m
  where m.id = any(coalesce(v_member_ids, '{}'::uuid[]))
    and not exists (
      select 1 from campaign_batch_members cbm
      where cbm.member_id = m.id
    );
  get diagnostics v_orphan_members_deleted = row_count;

  return jsonb_build_object(
    'batchDeleted', true,
    'batchMembersDeleted', v_batch_members_deleted,
    'installmentsDeleted', v_installments_deleted,
    'planTotalsDeleted', v_plan_totals_deleted,
    'consultationLogsDeleted', v_consultation_logs_deleted,
    'jobsDeleted', v_jobs_deleted,
    'orphanMembersDeleted', v_orphan_members_deleted,
    'campaignTotalsRecalculated', true
  );
end;
$$;

create or replace function delete_campaign_permanently(
  p_campaign_id uuid,
  p_requested_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_name text;
  v_batch_ids uuid[];
  v_member_ids uuid[];
  v_batches_deleted int := 0;
  v_batch_members_deleted int := 0;
  v_installments_deleted int := 0;
  v_plan_totals_deleted int := 0;
  v_consultation_logs_deleted int := 0;
  v_jobs_deleted int := 0;
  v_orphan_members_deleted int := 0;
begin
  select name into v_campaign_name
  from campaigns
  where id = p_campaign_id;

  if not found then
    raise exception 'campaign_not_found';
  end if;

  if exists (
    select 1 from processing_jobs pj
    where pj.campaign_id = p_campaign_id and pj.status = 'running'
  ) then
    raise exception 'campaign_running';
  end if;

  select array_agg(id) into v_batch_ids
  from campaign_batches
  where campaign_id = p_campaign_id;

  select array_agg(distinct member_id) into v_member_ids
  from campaign_batch_members
  where campaign_id = p_campaign_id;

  insert into deletion_audit_logs(action_type, requested_by, campaign_id, resource_name, removed_count, details)
  values ('campaign_delete', p_requested_by, p_campaign_id, v_campaign_name, coalesce(array_length(v_batch_ids, 1), 0), jsonb_build_object('batch_count', coalesce(array_length(v_batch_ids, 1), 0)));

  delete from member_installments mi
  using campaign_batch_members cbm
  where mi.campaign_batch_member_id = cbm.id
    and cbm.campaign_id = p_campaign_id;
  get diagnostics v_installments_deleted = row_count;

  delete from member_plan_totals mpt
  using campaign_batch_members cbm
  where mpt.campaign_batch_member_id = cbm.id
    and cbm.campaign_id = p_campaign_id;
  get diagnostics v_plan_totals_deleted = row_count;

  delete from consultation_logs cl
  using campaign_batch_members cbm
  where cl.campaign_batch_member_id = cbm.id
    and cbm.campaign_id = p_campaign_id;
  get diagnostics v_consultation_logs_deleted = row_count;

  delete from processing_jobs pj
  where pj.campaign_id = p_campaign_id;
  get diagnostics v_jobs_deleted = row_count;

  delete from campaign_batch_members
  where campaign_id = p_campaign_id;
  get diagnostics v_batch_members_deleted = row_count;

  delete from campaign_batches
  where campaign_id = p_campaign_id;
  get diagnostics v_batches_deleted = row_count;

  delete from campaigns
  where id = p_campaign_id;

  delete from members m
  where m.id = any(coalesce(v_member_ids, '{}'::uuid[]))
    and not exists (
      select 1 from campaign_batch_members cbm
      where cbm.member_id = m.id
    );
  get diagnostics v_orphan_members_deleted = row_count;

  return jsonb_build_object(
    'campaignDeleted', true,
    'batchesDeleted', v_batches_deleted,
    'batchMembersDeleted', v_batch_members_deleted,
    'installmentsDeleted', v_installments_deleted,
    'planTotalsDeleted', v_plan_totals_deleted,
    'consultationLogsDeleted', v_consultation_logs_deleted,
    'jobsDeleted', v_jobs_deleted,
    'orphanMembersDeleted', v_orphan_members_deleted
  );
end;
$$;
