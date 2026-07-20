-- Corrige exclusões permanentes para bancos que ainda possuem o modelo legado
-- (campaign_members) e o modelo normalizado (campaign_batch_members).
-- A exclusão permanece transacional e só pode ser executada pelo service_role,
-- após validação de um perfil administrador ativo.

alter table if exists public.member_plan_totals
  alter column campaign_member_id drop not null;

alter table if exists public.member_installments
  alter column campaign_member_id drop not null;

alter table if exists public.campaign_members
  drop constraint if exists campaign_members_campaign_id_fkey;

alter table if exists public.campaign_members
  add constraint campaign_members_campaign_id_fkey
  foreign key (campaign_id)
  references public.campaigns(id)
  on delete cascade;

alter table if exists public.campaign_members
  drop constraint if exists campaign_members_batch_id_fkey;

alter table if exists public.campaign_members
  add constraint campaign_members_batch_id_fkey
  foreign key (batch_id)
  references public.campaign_batches(id)
  on delete cascade;

alter table if exists public.member_plan_totals
  drop constraint if exists member_plan_totals_campaign_member_id_fkey;

alter table if exists public.member_plan_totals
  add constraint member_plan_totals_campaign_member_id_fkey
  foreign key (campaign_member_id)
  references public.campaign_members(id)
  on delete cascade;

alter table if exists public.member_installments
  drop constraint if exists member_installments_campaign_member_id_fkey;

alter table if exists public.member_installments
  add constraint member_installments_campaign_member_id_fkey
  foreign key (campaign_member_id)
  references public.campaign_members(id)
  on delete cascade;

alter table if exists public.consultation_logs
  drop constraint if exists consultation_logs_campaign_member_id_fkey;

alter table if exists public.consultation_logs
  add constraint consultation_logs_campaign_member_id_fkey
  foreign key (campaign_member_id)
  references public.campaign_members(id)
  on delete cascade;

alter table if exists public.consultation_logs
  drop constraint if exists consultation_logs_campaign_id_fkey;

alter table if exists public.consultation_logs
  add constraint consultation_logs_campaign_id_fkey
  foreign key (campaign_id)
  references public.campaigns(id)
  on delete cascade;

alter table if exists public.consultation_logs
  drop constraint if exists consultation_logs_batch_id_fkey;

alter table if exists public.consultation_logs
  add constraint consultation_logs_batch_id_fkey
  foreign key (batch_id)
  references public.campaign_batches(id)
  on delete cascade;

create or replace function public.delete_batch_permanently(
  p_batch_id uuid,
  p_requested_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
  v_batch_name text;
  v_member_ids uuid[] := '{}'::uuid[];
  v_batch_deleted integer := 0;
  v_batch_members_deleted integer := 0;
  v_legacy_members_deleted integer := 0;
  v_installments_deleted integer := 0;
  v_plan_totals_deleted integer := 0;
  v_consultation_logs_deleted integer := 0;
  v_jobs_deleted integer := 0;
  v_orphan_members_deleted integer := 0;
begin
  if not exists (
    select 1
    from public.profiles p
    where p.id = p_requested_by
      and p.ativo = true
      and p.role = 'administrador'
  ) then
    raise exception using errcode = '42501', message = 'delete_forbidden';
  end if;

  select cb.campaign_id, cb.name
    into v_campaign_id, v_batch_name
  from public.campaign_batches cb
  where cb.id = p_batch_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'batch_not_found';
  end if;

  if exists (
    select 1
    from public.processing_jobs pj
    where pj.batch_id = p_batch_id
      and pj.status = 'running'
  ) then
    raise exception using errcode = 'P0001', message = 'batch_running';
  end if;

  select coalesce(array_agg(distinct cbm.member_id), '{}'::uuid[])
    into v_member_ids
  from public.campaign_batch_members cbm
  where cbm.batch_id = p_batch_id;

  select count(*)::integer
    into v_batch_members_deleted
  from public.campaign_batch_members cbm
  where cbm.batch_id = p_batch_id;

  select count(*)::integer
    into v_legacy_members_deleted
  from public.campaign_members cm
  where cm.batch_id = p_batch_id;

  select count(*)::integer
    into v_installments_deleted
  from public.member_installments mi
  where exists (
      select 1
      from public.campaign_batch_members cbm
      where cbm.id = mi.campaign_batch_member_id
        and cbm.batch_id = p_batch_id
    )
    or exists (
      select 1
      from public.campaign_members cm
      where cm.id = mi.campaign_member_id
        and cm.batch_id = p_batch_id
    );

  select count(*)::integer
    into v_plan_totals_deleted
  from public.member_plan_totals mpt
  where exists (
      select 1
      from public.campaign_batch_members cbm
      where cbm.id = mpt.campaign_batch_member_id
        and cbm.batch_id = p_batch_id
    )
    or exists (
      select 1
      from public.campaign_members cm
      where cm.id = mpt.campaign_member_id
        and cm.batch_id = p_batch_id
    );

  select count(*)::integer
    into v_consultation_logs_deleted
  from public.consultation_logs cl
  where cl.batch_id = p_batch_id
    or exists (
      select 1
      from public.campaign_batch_members cbm
      where cbm.id = cl.campaign_batch_member_id
        and cbm.batch_id = p_batch_id
    )
    or exists (
      select 1
      from public.campaign_members cm
      where cm.id = cl.campaign_member_id
        and cm.batch_id = p_batch_id
    );

  select count(*)::integer
    into v_jobs_deleted
  from public.processing_jobs pj
  where pj.batch_id = p_batch_id;

  insert into public.deletion_audit_logs(
    action_type,
    requested_by,
    campaign_id,
    batch_id,
    resource_name,
    removed_count,
    details
  )
  values (
    'batch_delete',
    p_requested_by,
    v_campaign_id,
    p_batch_id,
    v_batch_name,
    v_batch_members_deleted + v_legacy_members_deleted,
    jsonb_build_object(
      'normalized_members', v_batch_members_deleted,
      'legacy_members', v_legacy_members_deleted,
      'installments', v_installments_deleted,
      'plan_totals', v_plan_totals_deleted,
      'consultation_logs', v_consultation_logs_deleted,
      'jobs', v_jobs_deleted
    )
  );

  delete from public.campaign_batches
  where id = p_batch_id;

  get diagnostics v_batch_deleted = row_count;

  if v_batch_deleted <> 1 then
    raise exception using errcode = 'P0002', message = 'batch_not_found';
  end if;

  delete from public.members m
  where m.id = any(v_member_ids)
    and not exists (
      select 1
      from public.campaign_batch_members cbm
      where cbm.member_id = m.id
    );

  get diagnostics v_orphan_members_deleted = row_count;

  perform public.recalculate_campaign_totals(v_campaign_id);

  return jsonb_build_object(
    'batchDeleted', true,
    'batchMembersDeleted', v_batch_members_deleted,
    'legacyMembersDeleted', v_legacy_members_deleted,
    'installmentsDeleted', v_installments_deleted,
    'planTotalsDeleted', v_plan_totals_deleted,
    'consultationLogsDeleted', v_consultation_logs_deleted,
    'jobsDeleted', v_jobs_deleted,
    'orphanMembersDeleted', v_orphan_members_deleted,
    'campaignTotalsRecalculated', true
  );
end;
$$;

create or replace function public.delete_campaign_permanently(
  p_campaign_id uuid,
  p_requested_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_name text;
  v_member_ids uuid[] := '{}'::uuid[];
  v_campaign_deleted integer := 0;
  v_batches_deleted integer := 0;
  v_batch_members_deleted integer := 0;
  v_legacy_members_deleted integer := 0;
  v_installments_deleted integer := 0;
  v_plan_totals_deleted integer := 0;
  v_consultation_logs_deleted integer := 0;
  v_jobs_deleted integer := 0;
  v_orphan_members_deleted integer := 0;
begin
  if not exists (
    select 1
    from public.profiles p
    where p.id = p_requested_by
      and p.ativo = true
      and p.role = 'administrador'
  ) then
    raise exception using errcode = '42501', message = 'delete_forbidden';
  end if;

  select c.name
    into v_campaign_name
  from public.campaigns c
  where c.id = p_campaign_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_not_found';
  end if;

  if exists (
    select 1
    from public.processing_jobs pj
    where pj.campaign_id = p_campaign_id
      and pj.status = 'running'
  ) then
    raise exception using errcode = 'P0001', message = 'campaign_running';
  end if;

  select coalesce(array_agg(distinct cbm.member_id), '{}'::uuid[])
    into v_member_ids
  from public.campaign_batch_members cbm
  where cbm.campaign_id = p_campaign_id;

  select count(*)::integer
    into v_batches_deleted
  from public.campaign_batches cb
  where cb.campaign_id = p_campaign_id;

  select count(*)::integer
    into v_batch_members_deleted
  from public.campaign_batch_members cbm
  where cbm.campaign_id = p_campaign_id;

  select count(*)::integer
    into v_legacy_members_deleted
  from public.campaign_members cm
  where cm.campaign_id = p_campaign_id;

  select count(*)::integer
    into v_installments_deleted
  from public.member_installments mi
  where exists (
      select 1
      from public.campaign_batch_members cbm
      where cbm.id = mi.campaign_batch_member_id
        and cbm.campaign_id = p_campaign_id
    )
    or exists (
      select 1
      from public.campaign_members cm
      where cm.id = mi.campaign_member_id
        and cm.campaign_id = p_campaign_id
    );

  select count(*)::integer
    into v_plan_totals_deleted
  from public.member_plan_totals mpt
  where exists (
      select 1
      from public.campaign_batch_members cbm
      where cbm.id = mpt.campaign_batch_member_id
        and cbm.campaign_id = p_campaign_id
    )
    or exists (
      select 1
      from public.campaign_members cm
      where cm.id = mpt.campaign_member_id
        and cm.campaign_id = p_campaign_id
    );

  select count(*)::integer
    into v_consultation_logs_deleted
  from public.consultation_logs cl
  where cl.campaign_id = p_campaign_id
    or exists (
      select 1
      from public.campaign_batch_members cbm
      where cbm.id = cl.campaign_batch_member_id
        and cbm.campaign_id = p_campaign_id
    )
    or exists (
      select 1
      from public.campaign_members cm
      where cm.id = cl.campaign_member_id
        and cm.campaign_id = p_campaign_id
    );

  select count(*)::integer
    into v_jobs_deleted
  from public.processing_jobs pj
  where pj.campaign_id = p_campaign_id;

  insert into public.deletion_audit_logs(
    action_type,
    requested_by,
    campaign_id,
    resource_name,
    removed_count,
    details
  )
  values (
    'campaign_delete',
    p_requested_by,
    p_campaign_id,
    v_campaign_name,
    v_batches_deleted,
    jsonb_build_object(
      'batches', v_batches_deleted,
      'normalized_members', v_batch_members_deleted,
      'legacy_members', v_legacy_members_deleted,
      'installments', v_installments_deleted,
      'plan_totals', v_plan_totals_deleted,
      'consultation_logs', v_consultation_logs_deleted,
      'jobs', v_jobs_deleted
    )
  );

  delete from public.campaigns
  where id = p_campaign_id;

  get diagnostics v_campaign_deleted = row_count;

  if v_campaign_deleted <> 1 then
    raise exception using errcode = 'P0002', message = 'campaign_not_found';
  end if;

  delete from public.members m
  where m.id = any(v_member_ids)
    and not exists (
      select 1
      from public.campaign_batch_members cbm
      where cbm.member_id = m.id
    );

  get diagnostics v_orphan_members_deleted = row_count;

  return jsonb_build_object(
    'campaignDeleted', true,
    'batchesDeleted', v_batches_deleted,
    'batchMembersDeleted', v_batch_members_deleted,
    'legacyMembersDeleted', v_legacy_members_deleted,
    'installmentsDeleted', v_installments_deleted,
    'planTotalsDeleted', v_plan_totals_deleted,
    'consultationLogsDeleted', v_consultation_logs_deleted,
    'jobsDeleted', v_jobs_deleted,
    'orphanMembersDeleted', v_orphan_members_deleted
  );
end;
$$;

revoke all on function public.delete_batch_permanently(uuid, uuid)
  from public, anon, authenticated;

revoke all on function public.delete_campaign_permanently(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.delete_batch_permanently(uuid, uuid)
  to service_role;

grant execute on function public.delete_campaign_permanently(uuid, uuid)
  to service_role;
