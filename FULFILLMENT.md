# WantWatcher Pro trial — fulfillment SOP

How a free-trial signup becomes an active trial. Written for the human
operator. **Today this is a manual process** — nothing below happens
automatically until the Discord/Stripe credentials are configured
(see "When credentials land").

## What the website promises

- 3-day free Pro trial, no card, nothing charged automatically.
- Instant verified-find alerts via a dedicated WantWatcher Discord server.
- When the trial ends: subscribe at C$8/month or let it lapse.

## The pipeline as it exists today

1. Visitor submits the trial form on `index.html`
   (Netlify Form `trial-signup`: name, email, optional Discord username,
   optional wanted item).
2. The submission lands in the Netlify dashboard (Site → Forms). **Nothing
   else happens.** No email is sent, no Discord invite goes out.
3. `netlify/functions/link-discord.js` (trial path) and
   `netlify/functions/expire-trials.js` (daily schedule) exist and are
   tested, but they are **dormant**: the Discord server, bot token, guild
   ID, role IDs, and Stripe key are not configured, so both functions
   return a clean `config_error` and do nothing.

## Manual SOP (do this for every signup, within 24h)

Set up the free form email notification first so you actually hear about
signups — exact steps in `DEPLOY_NOTES.md` ("Netlify Forms email
notifications").

For each submission:

1. **Reply to the signup email** (from the address in the submission):
   - Confirm the 3-day trial.
   - Send the WantWatcher Discord **server invite link**.
   - Ask them to reply with their Discord username once they've joined
     (or use the one from the form if provided).
2. **User joins the Discord server.**
3. **Grant the trial role manually**: Discord → Server Settings → Members →
   find the user → `+` → assign the trial role.
4. **Record the expiry**: trial start date + 3 days. Keep a simple tracker
   (a note, a sheet, anything) with: name, email, Discord username,
   trial start, trial end.
5. **On the expiry date, remove the trial role manually**
   (Server Settings → Members → user → remove trial role).
6. **Follow up** with a short email: trial ended, subscribe for C$8/month
   to keep instant alerts (payment link goes here once Stripe is live).

If a user never joins Discord, the trial can't deliver alerts — tell them
plainly and offer to restart the 3 days once they're in.

## Failure modes to know about

- `link-discord` (trial path) grants the Discord role *before* recording the
  expiry in Netlify Blobs. If the recording step fails, the function
  **automatically removes the role again** and returns `store_error`
  telling the caller to retry.
- If the automatic rollback itself fails, the response says an operator
  must remove the trial role manually. Check the function logs
  (Netlify → Functions → link-discord) after any `store_error`.
- `expire-trials` never deletes a trial record it failed to revoke — the
  next daily run retries. Malformed records are deleted and reported in
  the run's `errors` array.

## When credentials land

Once these exist, set them in Netlify (Site settings → Environment
variables) — never in code:

- `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`
- `DISCORD_PRO_ROLE_ID`, `DISCORD_TRIAL_ROLE_ID`
- `STRIPE_SECRET_KEY` (paid path only)

Then the automated flow becomes:

1. Trial signup → operator (or a small form-handling function, not yet
   built) POSTs `{ trial: true, discord_username }` to
   `/.netlify/functions/link-discord` → role granted + expiry recorded.
2. `expire-trials` (scheduled `@daily` in `netlify.toml`) revokes expired
   trial roles automatically.

Until then, the manual SOP above is the product.
