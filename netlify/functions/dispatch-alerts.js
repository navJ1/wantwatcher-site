/**
 * Netlify Function: dispatch-alerts (scheduled, every 30 minutes)
 *
 * Per-user keyword alert dispatcher. Each run:
 *   1. reads the last run's cutoff from Supabase `dispatcher_runs`
 *      (first ever run only establishes the watermark and sends nothing,
 *      so stale listings never trigger a flood),
 *   2. loads listings with created_at in (last_cutoff, now] from the
 *      listings store (default: Supabase `listings` table; swap via
 *      deps.loadListings — the seam Task 1's fetcher targets). The default
 *      loader drains the window with in-run keyset pagination so a busy
 *      window (>500 new listings) is never silently cut off; if the page
 *      budget (10 x 500) is exhausted, the run reports truncated: true.
 *      Custom loaders just return a rows array (may set .truncated too).
 *   3. loads all saved searches (service-role key, server-side only),
 *   4. matches: keyword (any comma-separated term, case-insensitive
 *      substring of the title) AND max_price_cad cap when set (listings
 *      with unknown price never match a capped search) AND marketplaces[]
 *      allow-list when set AND niche equality when both sides set it,
 *   5. for each match: INSERT into `alerts_sent` first, then send the
 *      email via Resend. A 409 on the insert means "already alerted" and
 *      the send is skipped; any other insert failure means NO send.
 *      This insert-then-send order makes re-runs idempotent: a crash
 *      after the insert costs at most one missed email, never a double.
 *   6. records the run in `dispatcher_runs` (best effort — a failure
 *      here is logged, not fatal).
 *
 * Returns JSON: { ok, since, listings_seen, matches, emails_sent,
 *   truncated, errors }.
 *
 * Env vars (all server-side, Netlify dashboard only):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (never in client code),
 *   RESEND_API_KEY, ALERT_FROM (optional; defaults to Resend's test
 *   sender until the wantwatcher.com domain is verified).
 * Missing keys -> clean `config_error` exit, no crash, no sends.
 *
 * Plain fetch/REST only — no SDKs. Node 18+ (global fetch).
 */

"use strict";

const RESEND_API = "https://api.resend.com/emails";
const MAX_LISTINGS_PER_RUN = 500;
// Safety cap on in-run pagination: a run drains at most this many pages
// (10 x 500 = 5,000 listings). If a window somehow exceeds it, the run
// records truncated: true instead of silently advancing past unseen rows.
const MAX_PAGES_PER_RUN = 10;
// Resend's free test sender. It only delivers to the Resend account
// owner's address until a custom domain is verified (see DEPLOY_NOTES.md).
const FROM_FALLBACK = "WantWatcher <onboarding@resend.dev>";
const DASHBOARD_URL = "https://wantwatcher.com/dashboard.html";

function fail(statusCode, code, detail) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: false, error: code, detail }),
  };
}

function sbHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

/** GET a PostgREST collection. query = { col: "op.value", ... } */
async function sbGet(fetchImpl, base, key, table, query = {}) {
  const params = new URLSearchParams();
  for (const [col, expr] of Object.entries(query)) params.append(col, expr);
  const res = await fetchImpl(
    `${base}/rest/v1/${table}?${params.toString()}`,
    { headers: sbHeaders(key) }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`supabase GET ${table} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * POST rows to a PostgREST collection.
 * Returns { status, body }. 409 = unique-violation (already exists).
 */
async function sbPost(fetchImpl, base, key, table, rows) {
  const res = await fetchImpl(`${base}/rest/v1/${table}`, {
    method: "POST",
    headers: sbHeaders(key),
    body: JSON.stringify(rows),
  });
  const text = await res.text().catch(() => "");
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body, text: text.slice(0, 200) };
}

/** Resolve a Supabase Auth user id to their email (service-role only). */
async function getUserEmail(fetchImpl, base, key, userId) {
  const res = await fetchImpl(
    `${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    { headers: sbHeaders(key) }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`auth user lookup ${res.status}: ${text.slice(0, 200)}`);
  }
  const user = await res.json();
  if (!user || !user.email) throw new Error("auth user has no email address");
  return user.email;
}

/** Comma-separated keywords -> lowercase terms. Empty -> [] (never matches). */
function searchTerms(search) {
  return String(search.keywords || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function matchesSearch(search, listing) {
  const terms = searchTerms(search);
  if (terms.length === 0) return false;
  const title = String(listing.title || "").toLowerCase();
  if (!terms.some((t) => title.includes(t))) return false;

  // Price cap: a listing with unknown price can never satisfy a cap.
  if (search.max_price_cad != null) {
    if (listing.price_cad == null) return false;
    if (Number(listing.price_cad) > Number(search.max_price_cad)) return false;
  }

  // Marketplace allow-list, when the search restricts it.
  const markets = Array.isArray(search.marketplaces)
    ? search.marketplaces
    : [];
  if (markets.length > 0 && !markets.includes(listing.source)) return false;

  // Niche equality, only when both sides declare one.
  if (search.niche && listing.niche && search.niche !== listing.niche)
    return false;

  return true;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function priceLabel(listing) {
  return listing.price_cad == null
    ? "price not listed"
    : `C$${Number(listing.price_cad).toFixed(2)}`;
}

function buildEmail(from, to, search, listing) {
  const title = String(listing.title || "New listing").slice(0, 120);
  return {
    from,
    to,
    subject: `WantWatcher alert: ${title.slice(0, 60)}`,
    html:
      `<p>A new listing matches your saved search ` +
      `<strong>${esc(search.keywords)}</strong>:</p>` +
      `<p><strong>${esc(title)}</strong><br>` +
      `${esc(priceLabel(listing))} &middot; ${esc(listing.source || "")}` +
      `${listing.location ? ` &middot; ${esc(listing.location)}` : ""}</p>` +
      `<p><a href="${esc(listing.url)}">View listing</a></p>` +
      `<p style="color:#666;font-size:12px">You're getting this because of a ` +
      `saved search on WantWatcher. ` +
      `<a href="${DASHBOARD_URL}">Manage your alerts</a>.</p>`,
  };
}

async function sendEmail(fetchImpl, apiKey, email) {
  const res = await fetchImpl(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(email),
  });
  if (res.status !== 200 && res.status !== 201) {
    const text = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * Default listings loader: Supabase `listings` created in (since, cutoff].
 *
 * Drains the window with in-run keyset pagination (composite cursor on
 * created_at, source, source_id) so a busy window is never silently
 * truncated: the old code took only the first MAX_LISTINGS_PER_RUN rows
 * and still advanced the watermark to `now`, permanently losing alert
 * eligibility for every row past the cap. Pagination stops when a page
 * is short, when a row exceeds the cutoff (rows are ordered ascending),
 * or at MAX_PAGES_PER_RUN — the last case sets a `truncated` property on
 * the returned array so the run can report it honestly.
 *
 * Same seam signature and return shape as before: (fetchImpl, base, key,
 * sinceISO, cutoffISO) -> Promise<rows[]> (array of listing rows).
 * `truncated` is attached as a plain property on the array, so any custom
 * loader that returns a plain array keeps working unchanged.
 */
async function defaultLoadListings(fetchImpl, base, key, sinceISO, cutoffISO) {
  const all = [];
  const seen = new Set(); // "source|source_id" — guards against any overlap
  let cursor = null; // { created_at, source, source_id } of the last row fetched
  let drained = false;

  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const query = {
      select:
        "source,source_id,title,price_cad,url,image,location,posted_at,niche,created_at",
      order: "created_at.asc,source.asc,source_id.asc",
      limit: String(MAX_LISTINGS_PER_RUN),
    };
    if (cursor === null) {
      query.created_at = `gt.${sinceISO}`;
    } else {
      // Keyset predicate: strictly after the cursor tuple. PostgREST `or`
      // with nested `and`/`or` implements the composite comparison.
      const c = cursor;
      query.or =
        `(created_at.gt.${c.created_at},` +
        `and(created_at.eq.${c.created_at},` +
        `or(source.gt.${c.source},` +
        `and(source.eq.${c.source},source_id.gt.${c.source_id}))))`;
    }

    const rows = await sbGet(fetchImpl, base, key, "listings", query);
    if (!Array.isArray(rows)) break; // unexpected shape: bail out honestly
    if (rows.length === 0) {
      drained = true; // no more rows — window fully drained
      break;
    }

    let sawPastCutoff = false;
    for (const r of rows) {
      if (r.created_at > cutoffISO) {
        // Ascending order: everything after this row is out of the window.
        sawPastCutoff = true;
        break;
      }
      const k = `${r.source}|${r.source_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(r);
    }

    const last = rows[rows.length - 1];
    cursor = {
      created_at: last.created_at,
      source: last.source,
      source_id: last.source_id,
    };
    // Short page, or the page crossed the cutoff: the window is drained.
    if (rows.length < MAX_LISTINGS_PER_RUN || sawPastCutoff) {
      drained = true;
      break;
    }
  }

  // We stopped only because the page budget ran out: more rows may exist
  // in the window, so flag it instead of pretending the drain completed.
  // Attached as a property so the seam's array return shape is unchanged.
  all.truncated = !drained;
  return all;
}

/**
 * Core logic with injectable deps for tests:
 * deps = { fetchImpl, now, loadListings }.
 * loadListings(fetchImpl, base, key, sinceISO, cutoffISO) -> Promise<rows>.
 */
async function dispatchAlerts(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || new Date();
  const loadListings = deps.loadListings || defaultLoadListings;

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    RESEND_API_KEY,
    ALERT_FROM,
  } = process.env;
  const missing = [
    ["SUPABASE_URL", SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY],
    ["RESEND_API_KEY", RESEND_API_KEY],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    // Clean exit: scheduled run logs JSON, retries next run. No sends.
    return fail(
      500,
      "config_error",
      `Missing ${missing.join(" / ")} — set in Netlify Site settings → Environment variables`
    );
  }

  const base = SUPABASE_URL.replace(/\/+$/, "");
  const from = ALERT_FROM || FROM_FALLBACK;
  const cutoffISO = now.toISOString();

  try {
    // 1. Watermark: last successful run's cutoff.
    const lastRuns = await sbGet(fetchImpl, base, SUPABASE_SERVICE_ROLE_KEY, "dispatcher_runs", {
      select: "ran_at",
      ok: "eq.true",
      order: "ran_at.desc",
      limit: "1",
    });
    const sinceISO = lastRuns.length > 0 ? lastRuns[0].ran_at : null;

    if (!sinceISO) {
      // First ever run: establish the watermark, send nothing. Prevents a
      // flood of alerts for listings that predate the dispatcher.
      await sbPost(fetchImpl, base, SUPABASE_SERVICE_ROLE_KEY, "dispatcher_runs", [
        {
          ran_at: cutoffISO,
          ok: true,
          listings_seen: 0,
          matches: 0,
          emails_sent: 0,
          errors: [],
        },
      ]);
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          bootstrapped: true,
          detail: "first run: watermark established, no emails sent",
        }),
      };
    }

    // 2 + 3. New listings and all saved searches.
    const [loadedListings, searches] = await Promise.all([
      loadListings(fetchImpl, base, SUPABASE_SERVICE_ROLE_KEY, sinceISO, cutoffISO),
      sbGet(fetchImpl, base, SUPABASE_SERVICE_ROLE_KEY, "saved_searches", {
        select: "id,user_id,keywords,niche,max_price_cad,marketplaces,enabled",
        enabled: "eq.true", // paused hunts stay in the DB but never alert
      }),
    ]);
    // The loader returns an array of rows; the default loader additionally
    // sets .truncated when the page budget ran out (see defaultLoadListings).
    const listings = Array.isArray(loadedListings) ? loadedListings : [];
    const truncated = !!loadedListings.truncated;

    // 4 + 5. Match, dedupe-insert, then send.
    const emailCache = {}; // user_id -> email
    const errors = [];
    let matches = 0;
    let emailsSent = 0;

    for (const listing of listings) {
      for (const search of searches) {
        if (!matchesSearch(search, listing)) continue;
        matches++;
        const dedupeKey = {
          search_id: search.id,
          source: listing.source,
          source_id: listing.source_id,
        };

        let insertRes;
        try {
          insertRes = await sbPost(
            fetchImpl,
            base,
            SUPABASE_SERVICE_ROLE_KEY,
            "alerts_sent",
            [dedupeKey]
          );
        } catch (e) {
          // Dedupe record could not be written: do NOT send. Next run
          // retries the whole match.
          errors.push({
            search_id: search.id,
            listing: `${listing.source}:${listing.source_id}`,
            error: `dedupe insert failed: ${e.message}`,
          });
          continue;
        }
        if (insertRes.status === 409) continue; // already alerted
        if (!insertRes.ok) {
          errors.push({
            search_id: search.id,
            listing: `${listing.source}:${listing.source_id}`,
            error: `dedupe insert ${insertRes.status}: ${insertRes.text}`,
          });
          continue;
        }

        let to;
        try {
          to =
            emailCache[search.user_id] ||
            (emailCache[search.user_id] = await getUserEmail(
              fetchImpl,
              base,
              SUPABASE_SERVICE_ROLE_KEY,
              search.user_id
            ));
        } catch (e) {
          // Dedupe row exists, email unknown: skip the send (no partial
          // send without a resolvable recipient). No double-send risk.
          errors.push({
            search_id: search.id,
            listing: `${listing.source}:${listing.source_id}`,
            error: `recipient lookup failed: ${e.message}`,
          });
          continue;
        }

        try {
          await sendEmail(
            fetchImpl,
            RESEND_API_KEY,
            buildEmail(from, to, search, listing)
          );
          emailsSent++;
        } catch (e) {
          // Dedupe row exists, send failed: logged, no retry this run.
          // Re-runs will not double-send (insert-then-send trade-off:
          // at most one missed email, never a duplicate).
          errors.push({
            search_id: search.id,
            listing: `${listing.source}:${listing.source_id}`,
            error: `resend failed: ${e.message}`,
          });
        }
      }
    }

    // 6. Record the run (best effort).
    try {
      await sbPost(fetchImpl, base, SUPABASE_SERVICE_ROLE_KEY, "dispatcher_runs", [
        {
          ran_at: cutoffISO,
          ok: errors.length === 0,
          listings_seen: listings.length,
          matches,
          emails_sent: emailsSent,
          errors,
        },
      ]);
    } catch (e) {
      errors.push({ error: `run record failed (non-fatal): ${e.message}` });
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        since: sinceISO,
        listings_seen: listings.length,
        matches,
        emails_sent: emailsSent,
        truncated,
        errors,
      }),
    };
  } catch (e) {
    // Supabase unreachable, malformed responses, etc: clean JSON error,
    // nothing sent, next run retries from the same watermark.
    return fail(500, "run_error", e.message);
  }
}

// Netlify scheduled function entry point (triggered by netlify.toml schedule).
exports.handler = async (event, context) => dispatchAlerts({});
exports.dispatchAlerts = dispatchAlerts; // exported for the test suite
exports.matchesSearch = matchesSearch; // exported for the test suite
exports.defaultLoadListings = defaultLoadListings; // exported for the test suite
