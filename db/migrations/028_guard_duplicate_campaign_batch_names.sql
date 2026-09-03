-- Impede a criacao de novos lotes ativos com o mesmo nome dentro da mesma
-- campanha, sem bloquear a migration caso a base historica ja contenha nomes
-- duplicados. O advisory lock serializa insercoes concorrentes por campanha.

create index if not exists campaign_batches_campaign_normalized_name_idx
  on campaign_batches(campaign_id, lower(btrim(name)))
  where deleted_at is null;

create or replace function guard_campaign_batch_name_uniqueness_v1()
returns trigger
language plpgsql
as $$
declare
  v_conflicting_id uuid;
begin
  if new.deleted_at is not null then
    return new;
  end if;

  new.name := btrim(new.name);
  if new.name = '' then
    raise exception using
      errcode = '23514',
      message = 'Nome do lote nao pode ser vazio.';
  end if;

  perform pg_advisory_xact_lock(20260903, hashtext(new.campaign_id::text));

  select id
    into v_conflicting_id
    from campaign_batches
   where campaign_id = new.campaign_id
     and deleted_at is null
     and id <> new.id
     and lower(btrim(name)) = lower(new.name)
   order by created_at asc, id asc
   limit 1;

  if v_conflicting_id is not null then
    raise exception using
      errcode = '23505',
      constraint = 'campaign_batches_active_name_guard',
      message = format(
        'Ja existe um lote "%s" nesta campanha. Selecione o lote existente ou informe outro nome.',
        new.name
      );
  end if;

  return new;
end;
$$;

drop trigger if exists campaign_batches_active_name_guard on campaign_batches;

create trigger campaign_batches_active_name_guard
before insert or update of campaign_id, name, deleted_at
on campaign_batches
for each row
execute function guard_campaign_batch_name_uniqueness_v1();

insert into schema_migrations(version, name)
values (28, 'guard_duplicate_campaign_batch_names')
on conflict (version) do nothing;
