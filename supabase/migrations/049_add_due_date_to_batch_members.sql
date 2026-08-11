alter table if exists public.campaign_batch_members
  add column if not exists due_date_text text;

comment on column public.campaign_batch_members.due_date_text is
  'Data de vencimento informada no upload; usada como fallback quando o ERP nao retornar vencimento.';

create or replace function public.sync_batch_member_due_date_from_installment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.campaign_batch_member_id is not null and nullif(new.due_date_text, '') is not null then
    update public.campaign_batch_members
    set due_date_text = new.due_date_text
    where id = new.campaign_batch_member_id
      and due_date_text is null;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_batch_member_due_date_from_installment
  on public.member_installments;

create trigger sync_batch_member_due_date_from_installment
after insert or update of due_date_text on public.member_installments
for each row
execute function public.sync_batch_member_due_date_from_installment();
