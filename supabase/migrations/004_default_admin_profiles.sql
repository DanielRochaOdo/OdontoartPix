-- New Supabase-auth users should receive an administrator profile by default.
-- Existing profiles are preserved.

alter table if exists profiles
  alter column role set default 'administrador';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, nome, email, role, ativo, created_at, updated_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome', new.email),
    new.email,
    'administrador',
    true,
    now(),
    now()
  )
  on conflict (id) do update
  set email = excluded.email,
      nome = excluded.nome,
      updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
