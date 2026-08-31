-- Snapshot operacional de processamentos manuais disparados no modulo Associados.
-- Cada solicitacao preserva o conjunto exato selecionado e os jobs efetivamente
-- usados, permitindo acompanhar o progresso mesmo quando a reconciliacao altera
-- o status financeiro e o registro deixa de atender ao filtro original.

create table if not exists associados_processing_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid references users(id) on delete set null,
  requested_count integer not null default 0 check (requested_count >= 0),
  batch_count integer not null default 0 check (batch_count >= 0),
  campaign_count integer not null default 0 check (campaign_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists associados_processing_items (
  request_id uuid not null references associados_processing_requests(id) on delete cascade,
  member_link_id uuid not null references campaign_batch_members(id) on delete cascade,
  processing_job_id uuid not null references processing_jobs(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  batch_id uuid not null references campaign_batches(id) on delete cascade,
  previous_payment_status text,
  created_at timestamptz not null default now(),
  primary key (request_id, member_link_id)
);

create index if not exists associados_processing_items_request_job_idx
  on associados_processing_items(request_id, processing_job_id);

create index if not exists associados_processing_items_job_idx
  on associados_processing_items(processing_job_id);

create index if not exists associados_processing_requests_created_idx
  on associados_processing_requests(created_at desc);

-- O primeiro deploy pode acontecer enquanto jobs unitarios, criados pela versao
-- anterior da tela, ainda estao em execucao. Cria um snapshot unico desses jobs
-- para que eles deixem de ficar invisiveis assim que a migration for aplicada.
do $$
declare
  backfill_request_id uuid;
begin
  if exists (
    select 1
      from processing_jobs pj
     where pj.processing_origin = 'manual'
       and pj.processing_scope = 'member'
       and pj.target_member_link_id is not null
       and pj.status in ('queued', 'running', 'paused', 'deferred')
       and not exists (
         select 1
           from associados_processing_items api
          where api.processing_job_id = pj.id
       )
  ) then
    insert into associados_processing_requests(
      requested_by, requested_count, batch_count, campaign_count, created_at, updated_at
    )
    select null,
           count(*)::int,
           count(distinct cbm.batch_id)::int,
           count(distinct cbm.campaign_id)::int,
           now(),
           now()
      from processing_jobs pj
      join campaign_batch_members cbm
        on cbm.id = pj.target_member_link_id
       and cbm.deleted_at is null
     where pj.processing_origin = 'manual'
       and pj.processing_scope = 'member'
       and pj.status in ('queued', 'running', 'paused', 'deferred')
       and not exists (
         select 1
           from associados_processing_items api
          where api.processing_job_id = pj.id
       )
    returning id into backfill_request_id;

    insert into associados_processing_items(
      request_id, member_link_id, processing_job_id, campaign_id, batch_id,
      previous_payment_status, created_at
    )
    select backfill_request_id,
           cbm.id,
           pj.id,
           cbm.campaign_id,
           cbm.batch_id,
           cbm.payment_status,
           now()
      from processing_jobs pj
      join campaign_batch_members cbm
        on cbm.id = pj.target_member_link_id
       and cbm.deleted_at is null
     where pj.processing_origin = 'manual'
       and pj.processing_scope = 'member'
       and pj.status in ('queued', 'running', 'paused', 'deferred')
       and not exists (
         select 1
           from associados_processing_items api
          where api.processing_job_id = pj.id
       );
  end if;
end;
$$;

insert into schema_migrations(version, name)
values (20, 'associados_processing_snapshots')
on conflict (version) do nothing;
