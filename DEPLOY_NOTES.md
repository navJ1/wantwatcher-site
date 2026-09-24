# DEPLOY_NOTES.md

Deployment-affecting changes to the WantWatcher site, newest first.
Rule: any change to `netlify.toml`, build settings, function config, or
hosting setup gets a dated entry here with what changed, why, and new
environment variables required.

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
