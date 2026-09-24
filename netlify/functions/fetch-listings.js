/**
 * Netlify Function: fetch-listings (scheduled, every 15 minutes)
 *
 * The "sweep" behind the site's "sweeps run every 15 minutes" claim.
 * Each run:
 *   1. loads enabled saved searches from Supabase `public.saved_searches`
 *      (the 20-searches-per-user cap is enforced by the DB trigger; the
 *      run additionally bounds itself to MAX_SEARCHES_PER_RUN rows),
 *   2. for each search listing 'ebay' in marketplaces: queries the eBay
 *      Buy Browse API (item_summary/search, EBAY_CA marketplace, CAD
 *      prices) via OAuth2 client-credentials, newest first, bounded to
 *      LIMIT_PER_PAGE x MAX_PAGES_PER_SEARCH rows per search,
 *   3. upserts every result into `public.listings` on (source, source_id)
 *      so re-runs never duplicate rows.
 *
 * Kijiji: documented no-op stub. Server-side scraping of Kijiji is
 * unreliable on a zero budget (bot protection, no public API), so the
 * stub logs and returns []. NEVER fabricate listings.
 *
 * No-op gracefully ({ ok: true, skipped: true }) when any of
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / EBAY_APP_ID / EBAY_CERT_ID
 * is unset — the schedule must never crash.
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EBAY_APP_ID,
 * EBAY_CERT_ID (eBay developer portal, free tier, no card).
 * Plain fetch/REST only — no SDKs. Node 18+ (global fetch).
 */

"use strict";

const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_SEARCH_URL =
  "https://api.ebay.com/buy/browse/v1/item_summary/search";
const EBAY_SCOPE = "https://api.ebay.com/api/pbsa";
const EBAY_MARKETPLACE = "EBAY_CA";

const LIMIT_PER_PAGE = 50;
const MAX_PAGES_PER_SEARCH = 2;
const MAX_SEARCHES_PER_RUN = 400;

function fail(statusCode, code, detail) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: false, code, detail }),
  };
}

/** Parse an eBay price object { value, currency } -> number|null.
 *  Invalid, missing, non-positive, or non-numeric prices become null
 *  (the listings.price_cad column is nullable; the dispatcher treats
 *  null-price rows as ineligible for capped searches). */
function parsePrice(price) {
  if (!price || typeof price !== "object") return null;
  const n = Number(price.value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Map one eBay itemSummary to a `public.listings` row (schema in
 *  supabase/migrations/002_alerts.sql). */
function mapEbayItem(item, niche) {
  const loc = item.itemLocation || {};
  const location = [loc.city, loc.stateOrProvince, loc.country]
    .filter(Boolean)
    .join(", ");
  return {
    source: "ebay",
    source_id: String(item.itemId),
    title: String(item.title || "").slice(0, 500),
    price_cad: parsePrice(item.price),
    url: item.itemWebUrl || "",
    image: (item.image && item.image.imageUrl) || null,
    location: location || null,
    posted_at: item.itemCreationDate || null,
    niche: niche || null,
  };
}

/** Kijiji source: not yet implemented. Server-side scraping is unreliable
 *  on a zero budget (bot protection, no public API), so this stays a
 *  documented stub. Returns [] — never fabricated listings. */
function fetchKijijiListings(search) {
  console.log(
    `fetch-listings: kijiji source not yet implemented (search keywords="${search.keywords}")`
  );
  return [];
}

/** OAuth2 client-credentials token for the eBay Buy APIs. */
async function getEbayToken(fetchImpl, appId, certId) {
  const res = await fetchImpl(EBAY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${appId}:${certId}`).toString("base64"),
    },
    body:
      "grant_type=client_credentials&scope=" +
      encodeURIComponent(EBAY_SCOPE),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ebay token ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("ebay token response missing access_token");
  }
  return data.access_token;
}

/** Query eBay Browse API for one saved search. Returns listing rows. */
async function searchEbay(fetchImpl, token, search) {
  const filters = ["priceCurrency:CAD"];
  if (
    search.max_price_cad !== null &&
    search.max_price_cad !== undefined &&
    Number(search.max_price_cad) > 0
  ) {
    filters.unshift(`price:[..${Number(search.max_price_cad).toFixed(2)}]`);
  }
  const rows = [];
  for (let page = 0; page < MAX_PAGES_PER_SEARCH; page++) {
    const params = new URLSearchParams({
      q: search.keywords,
      limit: String(LIMIT_PER_PAGE),
      offset: String(page * LIMIT_PER_PAGE),
      sort: "newlyListed",
      filter: filters.join(","),
    });
    const res = await fetchImpl(`${EBAY_SEARCH_URL}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ebay search ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const items = Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
    for (const item of items) {
      if (item && item.itemId) rows.push(mapEbayItem(item, search.niche));
    }
    if (items.length < LIMIT_PER_PAGE) break; // last page
  }
  return rows;
}

/** Enabled saved searches (bounded). */
async function loadSearches(fetchImpl, base, key) {
  const url =
    `${base}/rest/v1/saved_searches` +
    `?enabled=eq.true&select=keywords,max_price_cad,marketplaces,niche` +
    `&order=created_at.asc&limit=${MAX_SEARCHES_PER_RUN}`;
  const res = await fetchImpl(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`supabase saved_searches ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Upsert rows into `public.listings` on (source, source_id). */
async function upsertListings(fetchImpl, base, key, rows) {
  if (rows.length === 0) return 0;
  const res = await fetchImpl(
    `${base}/rest/v1/listings?on_conflict=source,source_id`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`supabase listings upsert ${res.status}: ${text.slice(0, 200)}`);
  }
  return rows.length;
}

/**
 * Core logic with injectable deps for tests:
 * deps = { fetchImpl }.
 */
async function fetchListings(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    EBAY_APP_ID,
    EBAY_CERT_ID,
  } = process.env;
  const missing = [
    ["SUPABASE_URL", SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY],
    ["EBAY_APP_ID", EBAY_APP_ID],
    ["EBAY_CERT_ID", EBAY_CERT_ID],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    // Graceful no-op: log, report skipped, never crash the schedule.
    const reason = `Missing ${missing.join(" / ")} — set in Netlify Site settings → Environment variables`;
    console.log(`fetch-listings: skipped. ${reason}`);
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, skipped: true, reason }),
    };
  }

  try {
    const base = SUPABASE_URL.replace(/\/+$/, "");
    const searches = await loadSearches(
      fetchImpl,
      base,
      SUPABASE_SERVICE_ROLE_KEY
    );
    const token = await getEbayToken(fetchImpl, EBAY_APP_ID, EBAY_CERT_ID);

    let ebaySearches = 0;
    let kijijiSearches = 0;
    let rowsUpserted = 0;
    const errors = [];

    for (const search of searches) {
      const markets = Array.isArray(search.marketplaces)
        ? search.marketplaces
        : [];
      try {
        if (markets.includes("ebay")) {
          ebaySearches++;
          const rows = await searchEbay(fetchImpl, token, search);
          rowsUpserted += await upsertListings(
            fetchImpl,
            base,
            SUPABASE_SERVICE_ROLE_KEY,
            rows
          );
        }
        if (markets.includes("kijiji")) {
          kijijiSearches++;
          fetchKijijiListings(search); // stub: logs, returns []
        }
      } catch (e) {
        // One bad search must not kill the sweep; the next run retries.
        errors.push({
          keywords: search.keywords,
          error: e.message,
        });
      }
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        searches_seen: searches.length,
        ebay_searches: ebaySearches,
        kijiji_searches: kijijiSearches,
        rows_upserted: rowsUpserted,
        errors,
      }),
    };
  } catch (e) {
    // Supabase/eBay unreachable, malformed responses, etc: clean JSON
    // error, nothing half-written (upserts are per-search, idempotent).
    return fail(500, "run_error", e.message);
  }
}

// Netlify scheduled function entry point (triggered by netlify.toml schedule).
exports.handler = async (event, context) => fetchListings({});
exports.fetchListings = fetchListings; // exported for the test suite
exports.mapEbayItem = mapEbayItem; // exported for the test suite
exports.parsePrice = parsePrice; // exported for the test suite
exports.fetchKijijiListings = fetchKijijiListings; // exported for the test suite
