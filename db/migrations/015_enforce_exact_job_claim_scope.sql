-- A fila local pode ter jobs de lote/campanha e jobs com escopo fechado no
-- mesmo batch. Esta camada de banco impede que um worker de um job fechado
-- reivindique qualquer associado fora do seu snapshot.

create or replace function enforce_processing_job_member_scope_v1()
returns trigger
language plpgsql
as $$
declare
  active_job processing_jobs%rowtype;
begin
  if new.processing_status <> 'processing'
     or new.processing_owner is null
     or old.processing_status = 'processing' then
    return new;
  end if;

  select pj.*
    into active_job
    from processing_jobs pj
   where pj.locked_by = new.processing_owner::text
     and pj.batch_id = new.batch_id
     and pj.status = 'running'
   order by pj.processing_priority desc, pj.locked_at desc nulls last, pj.created_at desc
   limit 1;

  if active_job.id is null then
    return new;
  end if;

  if active_job.target_member_link_id is not null
     and active_job.target_member_link_id <> new.id then
    return null;
  end if;

  if active_job.filtered_error_request_id is not null
     and not exists (
       select 1
         from filtered_error_reprocess_items item
        where item.request_id = active_job.filtered_error_request_id
          and item.member_link_id = new.id
          and item.status in ('queued', 'processing')
     ) then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_processing_job_member_scope_v1
  on campaign_batch_members;
create trigger trg_enforce_processing_job_member_scope_v1
before update of processing_status, processing_owner
on campaign_batch_members
for each row
execute function enforce_processing_job_member_scope_v1();

-- Assim que um job fechado contabiliza todos os itens terminais, encerra o
-- lease. Isso evita que a finalizacao generica de lote o mantenha aberto por
-- causa de itens alheios ao snapshot que estejam no mesmo batch.
create or replace function finalize_exact_processing_job_v1()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'running'
     and (new.target_member_link_id is not null or new.filtered_error_request_id is not null)
     and new.processed_items >= new.total_items then
    new.status := 'completed';
    new.finished_at := coalesce(new.finished_at, now());
    new.next_run_at := null;
    new.locked_by := null;
    new.locked_at := null;
    new.lease_expires_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_finalize_exact_processing_job_v1 on processing_jobs;
create trigger trg_finalize_exact_processing_job_v1
before update of processed_items, success_items, error_items, status
on processing_jobs
for each row
execute function finalize_exact_processing_job_v1();

insert into schema_migrations(version, name)
values (15, 'enforce_exact_job_claim_scope')
on conflict (version) do nothing;
