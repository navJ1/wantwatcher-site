# WantWatcher site — production readiness plan

Date: 2026-09-24. Goal: take `wantwatcher-site` from working prototype to
production-ready. Hard constraints: **C$0 spend** — no paid APIs, services,
or dependencies. Any change to deployment config / build / hosting must be
documented in `DEPLOY_NOTES.md` (root) with what changed, why, and new env
vars required.

## Current state (verified 2026-09-24)

- Pages: `index.html` (trial-first C$8 copy, live feed, spotlight, stats),
  `find.html` (per-find "why this deal" detail), `trial-thanks.html`.
- Feed renders client-side from `navJ1/wantwatcher-feed` `feed.json` with
  cache-busting; 49/49 watcher tests pass; JS syntax valid (node --check).
- Functions: `link-discord.js`, `expire-trials.js` (`@netlify/blobs` only dep).
- Trial signup: Netlify Forms (`trial-signup`) → `/trial-thanks.html`.

## Gaps found

1. **The core CTA promises what doesn't happen yet.** "Start free trial —
   no card" submits to the Netlify dashboard; nothing notifies anyone and
   nothing delivers the trial. Fulfillment is manual and undocumented.
2. **Sharing the site looks broken.** Zero OG/Twitter meta tags, empty
   favicon (`data:,`), no `sitemap.xml` / `robots.txt`, no `404.html`.
   Validation depends on sharing links that preview well.
3. **The feed is the product demo and it's thin.** One item, no filtering,
   bare loading/empty states, and the 8-hour delay explainer is easy to miss.

Non-issues: performance (tiny static pages), cost (no paid deps anywhere).

## The 3 tasks (parallel, isolated git worktrees)

### Task 1 — Close the trial fulfillment loop
- Wire free Netlify Forms notifications (email) — dashboard-side, document
  the exact clicks in `DEPLOY_NOTES.md`.
- Harden both functions for missing env (clear JSON error, no crash, no
  partial side effects); add/extend tests.
- Create `FULFILLMENT.md`: manual SOP from form submission → Discord invite
  → trial role → expiry, until Stripe/Discord creds land.
- Improve `trial-thanks.html` with an honest "what happens next" timeline
  (confirmation email → Discord invite within 24h → 3-day trial).
- If `netlify.toml` or function config changes: append to `DEPLOY_NOTES.md`.

### Task 2 — Share & SEO readiness
- OG + Twitter Card meta on `index.html` and dynamic-friendly tags on
  `find.html`; absolute canonical URLs (`https://wantwatcher.com`).
- Real favicon: inline SVG data-URI (zero new files/requests if inlined,
  or one `favicon.svg`).
- `sitemap.xml` (index, find, trial-thanks), `robots.txt`, branded `404.html`.
- Quick accessibility pass: alt text, label association, focus styles,
  color-contrast sanity on badges.
- If deploy config touched: append to `DEPLOY_NOTES.md`.

### Task 3 — Feed UX as product demo
- Niche filter chips above the grid (pure JS, derived from feed items).
- Skeleton loading cards instead of blank grid; sharper empty state.
- Make the 8-hour member delay + "verified vs price alert" meaning
  unmissable near the feed (one-line explainer + legend).
- Image fallback: graceful placeholder when a listing image 404s (keep
  existing `onerror` behavior, add styled placeholder block).
- Keep feed rendering working with both old and new `feed.json` shapes.
- If deploy config touched: append to `DEPLOY_NOTES.md`.

## Execution (after approval)

1. `git worktree add` three branches: `task/trial-fulfillment`,
   `task/share-seo`, `task/feed-ux`.
2. One background subagent per task, each confined to its worktree.
3. Each agent: implement → self-review → run relevant checks
   (node --check on scripts, function unit tests).
4. Merge order: Task 2, Task 3, then Task 1 (highest conflict potential last);
   resolve conflicts, re-verify, single squashed story per task on main.
5. Push to `navJ1/wantwatcher-site` once the GitHub repo exists (repo
   creation currently in flight); Netlify auto-deploys from main.

Out of scope: paid services, Discord/Stripe credential collection (user
provides separately), watcher backend changes, public posting.
