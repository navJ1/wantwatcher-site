# WantWatcher site

Public site for [wantwatcher.com](https://wantwatcher.com) — collector
marketplace alerts. Static pages + Netlify Functions, deployed on Netlify.

## Pages

- `index.html` — homepage: live verified-find feed, trial signup, pricing (C$8/mo)
- `find.html?id=<feed-item-id>` — find detail: why the watcher flagged it, price context, before-you-buy checklist
- `trial-thanks.html` — post-signup confirmation for the 3-day free trial

The live feed renders client-side from the watcher-pushed JSON:

`https://raw.githubusercontent.com/navJ1/wantwatcher-feed/main/feed.json`

## Functions (`netlify/functions/`)

- `link-discord.js` — verifies a Stripe session or trial token, assigns the Discord Pro/trial role
- `expire-trials.js` — scheduled (`@daily`); removes expired trial roles

Env vars (set in the Netlify dashboard, never committed):
`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_PRO_ROLE_ID`,
`DISCORD_TRIAL_ROLE_ID`, `STRIPE_SECRET_KEY`

## Trial signup

`index.html` has a Netlify Forms form (`name="trial-signup"`) posting to
`/trial-thanks.html`. Submissions appear in the Netlify dashboard under Forms.
