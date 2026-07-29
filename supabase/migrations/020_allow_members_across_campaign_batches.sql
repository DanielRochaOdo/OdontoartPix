-- Um associado pode participar de mais de um lote da mesma campanha.
-- A unicidade correta é somente dentro do próprio lote.
alter table if exists public.campaign_batch_members
  drop constraint if exists unique_campaign_member;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.campaign_batch_members'::regclass
      and conname = 'unique_batch_member'
  ) then
    alter table public.campaign_batch_members
      add constraint unique_batch_member unique (batch_id, member_id);
  end if;
end $$;
