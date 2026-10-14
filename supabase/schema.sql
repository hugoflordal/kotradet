-- Koträdet: one herd document per user. Paste into Supabase → SQL Editor and run.
-- Each logged-in user can read and write only their own row (row level security).

create table if not exists public.herds (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  doc jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.herds enable row level security;

drop policy if exists "own herd" on public.herds;
create policy "own herd" on public.herds
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Logged-out visitors get nothing; logged-in users only what the policy allows.
revoke all on public.herds from anon;
grant select, insert, update, delete on public.herds to authenticated;
