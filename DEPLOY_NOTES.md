# DEPLOY_NOTES.md

## 2026-09-24 — Fetcher engine (Task 1: eBay + Kijiji adapters, watcher-side)

**What changed** (in the watcher dir, not this repo — no site files touched):
- `ebay_adapter.py`: eBay Browse API behind `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET`
  (aliases `EBAY_APP_ID`/`EBAY_CERT_ID` accepted); clean skip without keys;
  `DRY_RUN=1` support; per-run call budget (default 50) under the 5,000/day free tier.
- `kijiji_adapter.py`: zero-cost, zero-auth Kijiji ingestion via search-page
  `__NEXT_DATA__` JSON; 1 request per 5s, 1 page per query, rotating cursor so
  18 keyword/location pairs are covered over ~3 runs; layout change = warn + skip.
- `listings_store.py`: unified Listing schema + JSONL backend (dedupe on
  `(source, source_id)`, auto-pruned); Supabase backend left as an explicit
  raising seam for later.
- Wired into the watcher's `main.py` additively; 15-min cron schedule and all
  existing outputs untouched. New env vars documented in the watcher's
  `ENV_NOTES_2026-09-24.md` (consolidated here per the audit rule).

**New environment variables** (watcher `.env`, all optional):
- `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` — eBay production keys (user approval pending)
- `EBAY_CALL_BUDGET_PER_RUN` (default 50), `DRY_RUN=1`, `ENABLE_KIJIJI` (default 1),
  `LISTINGS_BACKEND` (default jsonl)

**Tests:** new `test_fetchers.py` 21/21 pass; existing watcher suite 49/49 pass;
Kijiji adapter verified live (34 real Toronto listings pulled, nothing posted).

Deployment-affecting changes to the WantWatcher site, newest first.
Rule: any change to `netlify.toml`, build settings, function config, or
hosting setup gets a dated entry here with what changed, why, and new
environment variables required.

## 2026-09-24 — Alert dispatcher (Task 3: keyword alerts)

**What changed:**
- `netlify/functions/dispatch-alerts.js` (new): scheduled function that
  runs every 30 minutes. Each run reads the last run's cutoff from
  Supabase `dispatcher_runs` (first run only establishes the watermark
  and sends nothing, so stale listings never trigger a flood), loads new
  listings from the `listings` store, loads all saved searches, and for
  each match INSERTs into `alerts_sent` *before* sending one Resend email.
  Insert-then-send makes re-runs idempotent: at most one missed email on
  a crash, never a duplicate. Match = keyword (any comma-separated term,
  case-insensitive substring of title) AND `max_price_cad` cap when set
  (unknown-price listings never match a capped search) AND
  `marketplaces[]` allow-list when set AND niche equality when both sides
  set one. Recipient email comes from the Supabase Auth admin API
  (service-role key, server-side only). Missing keys → clean
  `config_error` exit, no sends, no crash. Plain fetch/REST, no SDKs.
- `netlify.toml`: added `[functions."dispatch-alerts"]` with
  `schedule = "*/30 * * * *"`. The existing `@daily` `expire-trials`
  entry is untouched.
- `supabase/migrations/002_alerts.sql` (new): creates `listings`
  (unified store the fetcher engine writes to), `alerts_sent`
  (PK on `(search_id, source, source_id)` — the dedupe ledger; depends on
  Task 2's `saved_searches`), and `dispatcher_runs` (run watermark +
  stats). RLS enabled with no public policies: only the service-role key
  can touch these tables. Run after Task 2's `001` migration in the
  Supabase SQL editor.
- `netlify/functions/test_dispatch_alerts.js` (new): 12 unit tests —
  fixture run sends exactly one email per new match, re-run sends zero
  duplicates, new listing sends exactly one, first-run bootstrap,
  missing-env clean exit, Resend-failure idempotency, Supabase-outage
  clean exit, plus `matchesSearch` unit tests. `npm test` now runs both
  function test files: **33/33 pass**.
- Existing Discord broadcast webhooks untouched; per-user Discord DMs
  remain deferred until the bot token arrives.

**Why:** per-user keyword alerts are the paid utility behind the C$8/mo
Pro tier; the curated Discord channel stays as the broadcast/marketing
layer.

**New environment variables** (Netlify dashboard → Site settings →
Environment variables; all server-side only, never in client code):
- `SUPABASE_URL` — e.g. `https://xyzcompany.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — **secret.** Function-only; it bypasses
  RLS. Never put it in `dashboard.html` or any client bundle (that page
  uses the public `SUPABASE_ANON_KEY` from Task 2).
- `RESEND_API_KEY` — from a free Resend account (100 emails/day,
  3,000/month, no credit card).
- `ALERT_FROM` (optional) — sender address. Defaults to Resend's test
  sender `onboarding@resend.dev`, which **only delivers to the Resend
  account owner's own address**. To email real users, verify
  `wantwatcher.com` in Resend (free: add the DNS TXT records Resend shows
  you to the domain's DNS), then set `ALERT_FROM` to e.g.
  `WantWatcher <alerts@wantwatcher.com>`.

**User steps remaining (all free, no card):**
1. Create a Supabase project (supabase.com → New project, free tier),
   run Task 2's `001` migration then this `002_alerts.sql` in the SQL
   editor, and copy the project URL + `anon` key (Task 2) + 
   `service_role` key (this task) into Netlify env vars.
2. Create a Resend account (resend.com, free tier), copy the API key
   into `RESEND_API_KEY`. Keep the default `ALERT_FROM` for testing;
   verify the `wantwatcher.com` domain in Resend before emailing real
   users (free DNS records).
3. Redeploy (or wait for the next auto-deploy): the `*/30` schedule
   takes effect on deploy. First scheduled run bootstraps the watermark
   and sends nothing; alerts begin on the second run.
4. eBay developer keys (already pending) unblock the fetcher engine
   (Task 1), which is what populates the `listings` table this function
   reads. Until then the dispatcher runs clean no-ops.
## 2026-09-24 — Saved-search dashboard (Supabase; not live until project exists)

**What changed:**
- `dashboard.html` (new): saved-search dashboard in the existing visual
  language. Supabase Auth email-link sign-in (no passwords); signed-in
  users list / add / delete saved searches via the Supabase JS client
  with the **anon key only**. Logged-out visitors get a friendly sign-in
  prompt. If Supabase isn't configured yet (placeholder values in
  `supabase/config.js`), the page shows an honest "almost here" panel —
  never a broken page or console errors. Honest copy: email alerts are
  noted as "go live next", not promised.
- `supabase/schema.sql` (new): `saved_searches` table
  (`id`, `user_id`, `keywords`, `niche`, `max_price_cad` nullable,
  `marketplaces` default `{ebay,kijiji}`, `created_at`) with Row Level
  Security enabled and four owner-only policies
  (SELECT/INSERT/UPDATE/DELETE where `user_id = auth.uid()`). Includes
  post-deploy RLS verification queries as comments.
- `supabase/config.js` (new): client-side config snippet holding
  `SUPABASE_URL` and `SUPABASE_ANON_KEY` placeholders. Both are
  public-safe; the **service-role key must never go in this file**.
- `index.html`: subtle "Dashboard" link added to the main nav
  (`.nav-quiet`, muted) and footer links. `sitemap.xml`: added
  `dashboard.html`.

**Why:** keyword tracking is the core engine's user-facing half; the
dashboard must exist before the Task 3 alert dispatcher has anything to
match against. Supabase (free tier, no card) provides Postgres + Auth so
no custom auth server is needed. Hosting stays on Netlify — no Vercel
re-platform.

**Deploy config changed?** No. `netlify.toml` untouched, no new functions,
no new build step. No Netlify env vars needed (the dashboard reads the
Supabase anon key from `supabase/config.js`, filled in at deploy time).

**Operator steps to go live (all free, no credit card):**
1. Create a Supabase project at supabase.com → copy the project URL and
   **anon** key (Project Settings → API).
2. SQL editor → paste and run `supabase/schema.sql` once. Run the
   verification queries in its comments to confirm RLS is on.
3. Authentication → URL Configuration → add
   `https://wantwatcher.com/dashboard.html` to Redirect URLs (required
   for the email magic link to return to the dashboard).
4. Authentication → Providers → Email: confirm magic-link/OTP email is
   enabled (default on).
5. Put the URL + anon key into `supabase/config.js` at deploy time
   (or via Netlify snippet injection), then deploy.

## 2026-09-24 — Function hardening (no deploy-config change)

**What changed:**
- `netlify/functions/link-discord.js`
  - Trial path: if the trial role is granted but the expiry record can't be
    saved to Netlify Blobs, the function now **rolls the role back**
    (DELETE) and returns `store_error` telling the caller to retry. If the
    rollback itself fails, the error says an operator must remove the role
    manually (procedure in `FULFILLMENT.md`).
  - Added a guard for a malformed Discord member lookup result
    (member object with no `user.id`) → clean `discord_error` 502 instead
    of an unhandled exception.
  - Missing-env behavior unchanged: `config_error` 500 naming the missing
    variable names (never values).
- `netlify/functions/expire-trials.js`
  - Blobs store acquisition/listing is now wrapped: a Blobs outage returns
    `store_error` 500 JSON instead of an unhandled exception crashing the
    scheduled run. The next daily run retries.
  - Malformed trial records: delete failures are now reported in the run's
    `errors` array instead of being silently swallowed.
- `netlify/functions/test_functions.js` (new): 21 unit tests covering
  missing-env, partial-failure/rollback, unpaid-session, not-in-server,
  retry-on-revoke-failure, and malformed-record paths. Run with
  `npm test` (new script in `package.json`).
- `FULFILLMENT.md` (new): manual trial-fulfillment SOP for the operator.
- `trial-thanks.html`: honest "what happens next" timeline (human-sent
  confirmation within 24h → Discord invite → 3-day trial → subscribe or lapse).

**Why:** the trial CTA is the site's core conversion path; the functions
must fail cleanly and never leave half-applied state (e.g. an unexpiring
trial role).

**Deploy config changed?** No. `netlify.toml` untouched. No new env vars.
Existing required env vars (set in Netlify dashboard, Site settings →
Environment variables): `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`,
`DISCORD_PRO_ROLE_ID`, `DISCORD_TRIAL_ROLE_ID`, `STRIPE_SECRET_KEY`
(paid path only). All are currently **unset** — both functions return
`config_error` until they land.

## Baseline deploy setup (as of 2026-09-24)

- Host: Netlify, site `harmonious-gumdrop-838cf6`, domains
  `wantwatcher.com` / `www.wantwatcher.com`.
- Deploy method: manual deploys; GitHub repo `navJ1/wantwatcher-site`
  pending creation, then connect repo → auto-deploy from `main`.
- Functions directory: `netlify/functions` (per `netlify.toml`).
- `expire-trials` runs on the `@daily` schedule declared in `netlify.toml`.
- Trial signup uses Netlify Forms (`trial-signup` in `index.html`);
  submissions appear under Site → Forms in the dashboard.

## Netlify Forms email notifications (free, dashboard-side)

Without this, trial signups sit silently in the dashboard. Set it up once:

1. Netlify dashboard → open the WantWatcher site.
2. **Site settings** (top nav) → **Forms** (left sidebar) → scroll to
   **Form notifications**.
3. Click **Add notification** → choose **Email notification**.
4. Fill in:
   - **Event to listen for:** `New form submission`
   - **Form:** `trial-signup` (appears after the first deploy containing
     the form; submit a test entry if it's not listed yet)
   - **Email to notify:** your operator address
5. **Save.** You'll get an email for every trial signup from now on.

Notes:
- This costs nothing and needs no code or env vars.
- Slack and outgoing-webhook notifications on the same screen are also
  free, if you prefer those later.
- Spam filtering: the form already has a honeypot (`netlify-honeypot`);
  enable Akismet in the same Forms settings screen if spam becomes a problem.
