-- WantWatcher saved searches — Supabase schema
-- Run ONCE in the Supabase dashboard: SQL editor → paste → Run.
-- Free tier, no credit card required. Safe to re-run (IF NOT EXISTS / DROP POLICY first).
--
-- Verifies RLS afterwards with the checks at the bottom of this file.

create extension if not exists "pgcrypto";

create table if not exists public.saved_searches (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users (id) on delete cascade,
  keywords      text        not null check (char_length(keywords) between 1 and 200),
  niche         text        not null default 'vintage-tech'
                check (niche in ('vintage-tech', 'retro-gaming', 'other')),
  max_price_cad numeric(10, 2) check (max_price_cad is null or max_price_cad > 0),
  marketplaces  text[]      not null default '{ebay,kijiji}',
  enabled       boolean     not null default true,  -- pause a hunt without deleting it
  created_at    timestamptz not null default now()
);

-- Added 2026-09-24 (Phase 4): enabled flag for hunts created before the column existed.
alter table public.saved_searches
  add column if not exists enabled boolean not null default true;

-- Per-user cap: max 20 saved searches. The dashboard enforces this too;
-- the trigger is the backstop so the dispatcher can never face unbounded work.
create or replace function public.cap_searches_per_user()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.saved_searches where user_id = new.user_id) >= 20 then
    raise exception 'maximum 20 saved searches per user';
  end if;
  return new;
end $$;

drop trigger if exists saved_searches_cap on public.saved_searches;
create trigger saved_searches_cap
  before insert on public.saved_searches
  for each row execute function public.cap_searches_per_user();

create index if not exists saved_searches_user_id_idx
  on public.saved_searches (user_id);

alter table public.saved_searches enable row level security;

-- Owner-only access for signed-in users. The anon key can only ever touch
-- rows whose user_id matches the caller's auth.uid().
drop policy if exists "saved_searches_owner_select" on public.saved_searches;
create policy "saved_searches_owner_select" on public.saved_searches
  for select
  using (auth.uid() = user_id);

drop policy if exists "saved_searches_owner_insert" on public.saved_searches;
create policy "saved_searches_owner_insert" on public.saved_searches
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "saved_searches_owner_update" on public.saved_searches;
create policy "saved_searches_owner_update" on public.saved_searches
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "saved_searches_owner_delete" on public.saved_searches;
create policy "saved_searches_owner_delete" on public.saved_searches
  for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Post-deploy verification (run as the postgres role in the SQL editor).
-- Replace the two placeholder UUIDs with real auth.users ids to simulate
-- two different signed-in users.
-- ---------------------------------------------------------------------------
-- -- 1. RLS is on:
-- select tablename, rowsecurity from pg_tables
--  where schemaname = 'public' and tablename = 'saved_searches';
--
-- -- 2. Policies exist (expect 4 rows):
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'saved_searches';
--
-- -- 3. Cross-user isolation: with RLS forced on for the table owner,
-- --    a row owned by user A must be invisible when acting as user B.
-- --    (Run each block separately, substituting real UUIDs.)
-- --    set role authenticated;
-- --    set request.jwt.claim.sub = '<USER_A_UUID>';
-- --    insert into public.saved_searches (user_id, keywords)
-- --      values ('<USER_A_UUID>', 'rls smoke test') returning id;
-- --    set request.jwt.claim.sub = '<USER_B_UUID>';
-- --    select count(*) from public.saved_searches;  -- expect 0
-- --    reset role;
