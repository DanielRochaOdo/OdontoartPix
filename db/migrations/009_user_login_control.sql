alter table users
  add column if not exists login_enabled boolean not null default true;

insert into schema_migrations(version, name)
values (9, 'user_login_control')
on conflict (version) do nothing;
