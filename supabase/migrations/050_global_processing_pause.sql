create table if not exists public.processing_control (
  id boolean primary key default true check (id),
  is_paused boolean not null default false,
  paused_at timestamptz,
  paused_by uuid references public.profiles(id) on delete set null,
  pause_reason text,
  updated_at timestamptz not null default now()
);

insert into public.processing_control (id)
values (true)
on conflict (id) do nothing;

alter table public.processing_control enable row level security;
