# WantWatcher core engine plan — keyword tracking + alerts

Date: 2026-09-24. Goal: micro-SaaS MVP capable of **C$100 MRR** (13 subs at
C$8/mo). Hard constraints: **C$0 spend** — no paid proxies, scrapers, or
card-required services. No Facebook Marketplace in V1. Any change to deploy
config, cron, schemas, or env vars gets a dated entry in `DEPLOY_NOTES.md`.

## Current state

- **Site repo** (this repo, on `master`, pushed pending): static pages,
  Netlify Functions (`link-discord`, `expire-trials`), Netlify Blobs,
  daily `expire-trials` schedule. Trial-first C$8 copy, live feed, detail
  pages, SEO/share ready.
- **Watcher** (`~/workspace/goals/launch-rare-item-watcher-subscription-service/hidden_files/watcher/`):
  browser-sweep ingestion, eBay API client code (no prod keys yet), model-aware
  matching, dedupe, `feed.json` push, Discord webhook posts, 15-min cron.
- **Missing**: per-user saved searches, user accounts, per-user alert
  delivery, Kijiji coverage, email channel.

## Analysis findings (verified 2026-09-24)

1. **Kijiji is fetchable at zero cost.** No public RSS (returns 403), but
   search pages return HTTP 200 to a plain request and embed full listing
   data (title, price in cents, URL, location) in `__NEXT_DATA__` JSON.
   Fetcher = HTTP GET + JSON parse, no auth, no proxy. Be conservative
   (≤1 req/5s, few pages per cycle) and fail soft on layout changes.
2. **eBay Browse API is free** (5,000 calls/day, no card) but needs an
   approved developer account — approval already pending; keys come from
   the user via Secure Vault. Client-credentials OAuth, `search` endpoint.
3. **Hosting stays on Netlify.** The prompt suggested Vercel + Supabase;
   re-platforming hosting now buys nothing: domain, functions, and Blobs
   are already live on Netlify's free tier. Supabase free tier (Postgres +
   Auth, no card) is still the right pick for the *database*, used from
   Netlify. Revisit only if Netlify limits ever bite.
4. **Product note:** this adds *self-serve keyword alerts* next to the
   *curated feed*. They complement each other (feed = proof/marketing,
   keyword alerts = the paid utility). Build order: fetchers → dashboard
   → dispatcher.

## The 3 tasks (parallel)

### Task 1 — Free-tier fetcher engine
Location: watcher dir (not a git repo; agent works there directly, no
worktree — Tasks 2/3 use site-repo worktrees so there is no conflict).
- eBay adapter: client-credentials OAuth, `search` per keyword query,
  runs only when `EBAY_APP_ID`/`EBAY_CERT_ID` present, else skips cleanly.
  `DRY_RUN=1` first, validate quotas and filtering.
- Kijiji adapter: fetch search URL (keyword + location), parse
  `__NEXT_DATA__` → `CoreListing:*` entities → normalized listings.
  Conservative rate limits; layout change = log + skip, never crash.
- Unified `Listing` schema: source, source_id, title, price_cad, url,
  image, location, posted_at, niche. Dedupe on (source, source_id).
  Write to the listings store (Blobs JSON now; Supabase table once Task 2
  lands — keep a clean seam).
- No Facebook, no proxies, no paid scrapers, no new paid deps.
- Accept: dry-run pulls ≥1 real listing per source; parser unit tests
  with saved fixtures; `DEPLOY_NOTES.md` entry for new env vars.

### Task 2 — Saved-search dashboard
Location: site repo worktree `task/saved-searches`.
- New Supabase project (free tier, user creates it — no card). Schema:
  `saved_searches(id, user_id, keywords, niche, max_price_cad,
  marketplaces[], created_at)` with RLS: users read/write only their own.
- New `dashboard.html`: Supabase Auth email-link sign-in (no passwords),
  list/add/delete saved searches, pure client-side JS with the anon key.
  Logged-out state shows a sign-in prompt, not a broken page.
- `DEPLOY_NOTES.md`: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public-safe),
  schema SQL file, RLS verification notes.
- Accept: user can sign in and CRUD searches; RLS proven (A can't read
  B's rows); works with zero saved searches.

### Task 3 — Alert dispatcher
Location: site repo worktree `task/alert-dispatcher`.
- Scheduled Netlify function (every 30 min, free tier): load new listings
  since last run, match against all saved searches (keyword match + price
  cap), write matches to `alerts_sent(search_id, source, source_id)` to
  dedupe, send email per match via **Resend** free tier (100/day, no
  card; test sender domain first, custom domain later via free DNS).
- Keep existing Discord broadcast webhooks for the curated Pro channel;
  per-user Discord DMs stay deferred until the bot token arrives.
- `DEPLOY_NOTES.md`: schedule, `RESEND_API_KEY`, from-address/domain
  notes, Supabase service-role key handling (function-only, never in
  client code).
- Accept: fixture run sends exactly one email per new match; re-run
  sends zero duplicates; missing keys = clean skip, not a crash.

## Execution (after approval)

1. Task 1 agent → watcher dir directly. Tasks 2 & 3 → isolated worktrees
   `task/saved-searches`, `task/alert-dispatcher` in this repo.
2. Each agent: implement → self-review → run relevant checks → commit
   (Tasks 2/3 on their branches; Task 1 as a dated snapshot note since
   the watcher dir isn't versioned).
3. Merge order: Task 2, then Task 3 (both touch `DEPLOY_NOTES.md` —
   reconcile by hand); Task 1 has no merge.
4. Push to `navJ1/wantwatcher-site` once the pending push unblocks.

## User-provided (free, no card)

- eBay developer keys (approval pending) → Secure Vault
- Supabase project URL + anon key (+ service-role key for the dispatcher)
- Resend API key (free tier)
- Later: Discord bot token, Stripe key (paid path)

Out of scope: Facebook Marketplace, paid proxies/scrapers, Vercel
migration, per-user Discord DMs, mobile apps.
