-- Snapshots fechados para reprocessamento de erros no PostgreSQL local.
-- Nenhum erro posterior entra automaticamente em um pedido ja criado.

create table if not exists filtered_error_reprocess_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid references users(id) on delete set null,
  requested_count integer not null default 0 check (requested_count >= 0),
  batch_count integer not null default 0 check (batch_count >= 0),
  campaign_count integer not null default 0 check (campaign_count >= 0),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists filtered_error_reprocess_items (
  request_id uuid not null references filtered_error_reprocess_requests(id) on delete cascade,
  member_link_id uuid not null references campaign_batch_members(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  batch_id uuid not null references campaign_batches(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'resolved', 'failed')),
  attempt_started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (request_id, member_link_id)
);

create index if not exists filtered_error_items_request_status_idx
  on filtered_error_reprocess_items(request_id, status);
create index if not exists filtered_error_items_member_open_idx
  on filtered_error_reprocess_items(member_link_id, status)
  where status in ('queued', 'processing');

create table if not exists dashboard_error_reprocess_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  run_id uuid not null references general_sync_runs(id) on delete cascade,
  batch_id uuid not null references campaign_batches(id) on delete cascade,
  campaign_batch_member_id uuid not null references campaign_batch_members(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retrying', 'resolved', 'failed')),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, campaign_batch_member_id)
);

create index if not exists dashboard_error_items_run_status_idx
  on dashboard_error_reprocess_items(run_id, status, requested_at desc);
create index if not exists dashboard_error_items_member_open_idx
  on dashboard_error_reprocess_items(campaign_batch_member_id, status, requested_at desc)
  where status in ('queued', 'processing', 'retrying');

alter table processing_jobs
  add column if not exists filtered_error_request_id uuid
    references filtered_error_reprocess_requests(id) on delete set null;

create index if not exists processing_jobs_filtered_error_request_idx
  on processing_jobs(filtered_error_request_id)
  where filtered_error_request_id is not null;

create or replace function sync_local_error_replay_snapshots_v1()
returns trigger
language plpgsql
as $$
declare
  request_row record;
begin
  if new.processing_status is not distinct from old.processing_status then
    return new;
  end if;

  if new.processing_status = 'processing' then
    update filtered_error_reprocess_items
       set status = 'processing',
           attempt_started_at = coalesce(attempt_started_at, now()),
           finished_at = null,
           updated_at = now()
     where member_link_id = new.id
       and status = 'queued';

    update dashboard_error_reprocess_items
       set status = 'processing',
           started_at = coalesce(started_at, now()),
           finished_at = null,
           updated_at = now()
     where campaign_batch_member_id = new.id
       and status in ('queued', 'retrying');
  elsif new.processing_status = 'completed' then
    update filtered_error_reprocess_items
       set status = 'resolved',
           attempt_started_at = coalesce(attempt_started_at, now()),
           finished_at = coalesce(finished_at, now()),
           updated_at = now()
     where member_link_id = new.id
       and status in ('queued', 'processing');

    update dashboard_error_reprocess_items
       set status = 'resolved',
           finished_at = coalesce(finished_at, now()),
           updated_at = now()
     where campaign_batch_member_id = new.id
       and status in ('queued', 'processing', 'retrying');
  elsif new.processing_status = 'retrying' then
    update dashboard_error_reprocess_items
       set status = 'retrying',
           updated_at = now()
     where campaign_batch_member_id = new.id
       and status = 'processing';
  elsif new.processing_status = 'error' then
    update filtered_error_reprocess_items
       set status = 'failed',
           attempt_started_at = coalesce(attempt_started_at, now()),
           finished_at = coalesce(finished_at, now()),
           updated_at = now()
     where member_link_id = new.id
       and status = 'processing';

    update dashboard_error_reprocess_items
       set status = 'failed',
           finished_at = coalesce(finished_at, now()),
           updated_at = now()
     where campaign_batch_member_id = new.id
       and status = 'processing';
  end if;

  for request_row in
    select distinct request_id
      from filtered_error_reprocess_items
     where member_link_id = new.id
  loop
    update filtered_error_reprocess_requests r
       set status = case
             when not exists (
               select 1 from filtered_error_reprocess_items i
                where i.request_id = r.id and i.status in ('queued', 'processing')
             ) then 'completed'
             when exists (
               select 1 from filtered_error_reprocess_items i
                where i.request_id = r.id and i.attempt_started_at is not null
             ) then 'running'
             else 'queued'
           end,
           started_at = case
             when exists (
               select 1 from filtered_error_reprocess_items i
                where i.request_id = r.id and i.attempt_started_at is not null
             ) then coalesce(r.started_at, now())
             else r.started_at
           end,
           finished_at = case
             when not exists (
               select 1 from filtered_error_reprocess_items i
                where i.request_id = r.id and i.status in ('queued', 'processing')
             ) then coalesce(r.finished_at, now())
             else null
           end,
           updated_at = now()
     where r.id = request_row.request_id;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_sync_local_error_replay_snapshots_v1 on campaign_batch_members;
create trigger trg_sync_local_error_replay_snapshots_v1
after update of processing_status on campaign_batch_members
for each row execute function sync_local_error_replay_snapshots_v1();

insert into schema_migrations(version, name)
values (14, 'exact_error_replay_snapshots')
on conflict (version) do nothing;
