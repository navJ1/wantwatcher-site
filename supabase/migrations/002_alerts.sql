-- 002_alerts.sql — WantWatcher alert dispatcher schema
--
-- Depends on 001 (Task 2): public.saved_searches(id uuid, user_id uuid, ...).
-- Run in the Supabase SQL editor (free tier, no card needed).
--
-- Tables:
--   public.listings        — unified listing store written by the fetcher
--                            engine (Task 1 targets this schema).
--   public.alerts_sent     — dedupe ledger: one row per (search, listing)
--                            alerted. The dispatcher INSERTs before sending,
--                            so a re-run can never double-send.
--   public.dispatcher_runs — per-run watermark + stats. The dispatcher only
--                            processes listings newer than the last run's
--                            ran_at cutoff.
--
-- RLS is enabled with NO public policies: only the service-role key (used
-- server-side by the dispatch-alerts Netlify Function) can read/write.
-- The anon key used by dashboard.html gets nothing here.

-- Unified listing store (fetcher engine writes here; dispatcher reads here).
create table if not exists public.listings (
  source      text        not null,  -- 'ebay' | 'kijiji'
  source_id   text        not null,  -- marketplace-native listing id
  title       text        not null,
  price_cad   numeric,               -- null when the price is unknown
  url         text        not null,
  image       text,
  location    text,
  posted_at   timestamptz,
  niche       text,
  created_at  timestamptz not null default now(),
  primary key (source, source_id)
);
create index if not exists listings_created_at_idx
  on public.listings (created_at);

-- Dedupe ledger. Unique (search_id, source, source_id) => insert-then-send
-- is idempotent: a conflicting insert returns 409 and the send is skipped.
create table if not exists public.alerts_sent (
  search_id uuid        not null references public.saved_searches(id) on delete cascade,
  source    text        not null,
  source_id text        not null,
  sent_at   timestamptz not null default now(),
  primary key (search_id, source, source_id)
);

-- Run watermark + audit trail.
create table if not exists public.dispatcher_runs (
  id            bigint generated always as identity primary key,
  ran_at        timestamptz not null, -- cutoff: listings with created_at <= ran_at were considered
  ok            boolean     not null default true,
  listings_seen int         not null default 0,
  matches       int         not null default 0,
  emails_sent   int         not null default 0,
  errors        jsonb       not null default '[]'::jsonb,
  finished_at   timestamptz not null default now()
);

-- Service-role only: no policies for anon/authenticated.
alter table public.listings        enable row level security;
alter table public.alerts_sent     enable row level security;
alter table public.dispatcher_runs enable row level security;
