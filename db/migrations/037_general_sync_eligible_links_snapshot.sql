-- Snapshot of initially eligible batch links. A terminal payment promoted by
-- an earlier batch must not inflate reused_count on later batches.
create table if not exists general_sync_run_eligible_links (
  run_id uuid not null references general_sync_runs(id) on delete cascade,
  member_link_id uuid not null references campaign_batch_members(id) on delete cascade,
  batch_id uuid not null references campaign_batches(id) on delete cascade,
  target_installment_ref_id uuid references member_target_installments(id) on delete set null,
  primary key (run_id, member_link_id)
);

create index if not exists general_sync_eligible_links_batch_target_idx
  on general_sync_run_eligible_links(run_id, batch_id, target_installment_ref_id);

comment on table general_sync_run_eligible_links is
  'Vinculos inicialmente elegiveis em uma sincronizacao geral, protegidos contra mudancas financeiras posteriores.';

-- CI can use a single PostgreSQL user; production has a separate runtime role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'odontoart_pix_app') then
    grant select, insert, update, delete on table general_sync_run_eligible_links
      to odontoart_pix_app;
  end if;
end;
$$;

insert into schema_migrations(version, name)
values (37, 'general_sync_eligible_links_snapshot')
on conflict (version) do nothing;
