/**
 * Unit tests for the alert dispatcher (netlify/functions/dispatch-alerts.js).
 *
 * No network, no real credentials: Supabase (PostgREST + Auth admin) and
 * Resend are faked behind one injected fetchImpl; listings come through
 * the deps.loadListings seam. Fixtures only — no real users.
 * Run: node --test netlify/functions/test_dispatch_alerts.js
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  dispatchAlerts,
  matchesSearch,
  defaultLoadListings,
} = require("../netlify/functions/dispatch-alerts.js");

// ---------------------------------------------------------------- fixtures

const T0 = "2026-09-24T00:00:00.000Z"; // prior run cutoff
const T1 = "2026-09-24T01:00:00.000Z"; // listing creation time
const NOW = new Date("2026-09-24T02:00:00.000Z");

function baseSearches() {
  return [
    { id: "s1", user_id: "u1", keywords: "ipod classic", niche: "ipod", max_price_cad: 250, marketplaces: ["ebay", "kijiji"] },
    { id: "s2", user_id: "u2", keywords: "lego", niche: null, max_price_cad: null, marketplaces: [] },
    { id: "s3", user_id: "u1", keywords: "   ", niche: null, max_price_cad: null, marketplaces: [] }, // malformed: no terms
    { id: "s4", user_id: "u3", keywords: "gameboy", niche: null, max_price_cad: null, marketplaces: ["ebay"] },
  ];
}

function baseListings() {
  return [
    { source: "ebay", source_id: "e1", title: "Apple iPod Classic 160GB 7th gen", price_cad: 199.0, url: "https://ebay.ca/itm/e1", image: null, location: "Toronto", posted_at: T1, niche: "ipod", created_at: T1 },
    { source: "kijiji", source_id: "k1", title: "iPod classic 5.5 gen 80gb", price_cad: 300.0, url: "https://kijiji.ca/v/k1", image: null, location: "Edmonton", posted_at: T1, niche: "ipod", created_at: T1 }, // over s1 cap
    { source: "ebay", source_id: "e2", title: "LEGO Star Wars Millennium Falcon", price_cad: 49.99, url: "https://ebay.ca/itm/e2", image: null, location: "Vancouver", posted_at: T1, niche: "lego", created_at: T1 },
    { source: "kijiji", source_id: "k2", title: "Nintendo GameBoy Advance SP", price_cad: 120.0, url: "https://kijiji.ca/v/k2", image: null, location: "Calgary", posted_at: T1, niche: "retro", created_at: T1 }, // s4: marketplace-filtered
    { source: "ebay", source_id: "e3", title: "GameBoy Color console", price_cad: null, url: "https://ebay.ca/itm/e3", image: null, location: null, posted_at: T1, niche: "retro", created_at: T1 }, // s4: null price, no cap -> match; u3 email lookup fails
  ];
}

const USER_EMAILS = { u1: "user1@example.com", u2: "user2@example.com" }; // u3 unknown

// ---------------------------------------------------------------- fakes

function fakeResp(status, jsonBody) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => jsonBody,
    text: async () =>
      jsonBody === undefined ? "" : JSON.stringify(jsonBody),
  };
}

/**
 * Fake Supabase + Resend behind one fetch.
 * state = { searches, listings, alerts: Set("search|source|source_id"),
 *           runs: [{ran_at, ok, ...}], outbox: [], resendFailFor: Set<to> }
 */
function makeWorld(state = {}) {
  const w = {
    searches: state.searches || [],
    listings: state.listings || [],
    alerts: state.alerts || new Set(),
    runs: state.runs || [],
    outbox: [],
    resendFailFor: state.resendFailFor || new Set(),
    fetchCalls: 0,
  };

  async function fetchImpl(url, opts = {}) {
    w.fetchCalls++;
    const method = (opts.method || "GET").toUpperCase();
    const u = new URL(url, "https://test.supabase.co");

    // --- Resend ---
    if (u.hostname === "api.resend.com") {
      const email = JSON.parse(opts.body);
      if (w.resendFailFor.has(email.to)) {
        return fakeResp(500, { error: "resend boom" });
      }
      w.outbox.push(email);
      return fakeResp(200, { id: `re_${w.outbox.length}` });
    }

    // --- Auth admin: user email lookup ---
    const m = u.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/);
    if (m) {
      const email = USER_EMAILS[decodeURIComponent(m[1])];
      return email ? fakeResp(200, { email }) : fakeResp(404, { msg: "not found" });
    }

    // --- PostgREST ---
    if (u.pathname === "/rest/v1/saved_searches" && method === "GET") {
      return fakeResp(200, w.searches);
    }
    if (u.pathname === "/rest/v1/dispatcher_runs" && method === "GET") {
      const rows = w.runs
        .filter((r) => r.ok)
        .sort((a, b) => (a.ran_at < b.ran_at ? 1 : -1))
        .slice(0, Number(u.searchParams.get("limit") || 1));
      return fakeResp(200, rows);
    }
    if (u.pathname === "/rest/v1/dispatcher_runs" && method === "POST") {
      w.runs.push(...JSON.parse(opts.body));
      return fakeResp(201, []);
    }
    if (u.pathname === "/rest/v1/alerts_sent" && method === "POST") {
      const rows = JSON.parse(opts.body);
      for (const r of rows) {
        const k = `${r.search_id}|${r.source}|${r.source_id}`;
        if (w.alerts.has(k)) {
          // PostgREST unique-violation
          return fakeResp(409, { code: "23505", message: "duplicate key" });
        }
        w.alerts.add(k);
      }
      return fakeResp(201, []);
    }
    if (u.pathname === "/rest/v1/listings" && method === "GET") {
      return fakeResp(200, fakeListingsPage(w.listings, url));
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }

  // Listings via the documented seam (filters like the default loader).
  async function loadListings(fetchImplArg, base, key, sinceISO, cutoffISO) {
    return w.listings.filter(
      (l) => l.created_at > sinceISO && l.created_at <= cutoffISO
    );
  }

  return { world: w, fetchImpl, loadListings };
}

function bodyOf(res) {
  return JSON.parse(res.body);
}

/**
 * Minimal PostgREST stand-in for the `listings` table, honoring the query
 * shape defaultLoadListings produces: created_at=gt.<iso> on the first
 * page, the composite `or` keyset predicate on later pages, ascending
 * (created_at, source, source_id) order, and limit.
 */
function fakeListingsPage(rows, url) {
  const p = new URL(url).searchParams;
  let filtered = rows.slice();
  const orExpr = p.get("or");
  if (orExpr) {
    // (created_at.gt.C,and(created_at.eq.C,or(source.gt.S,and(source.eq.S,source_id.gt.SID))))
    const c = orExpr.match(/created_at\.gt\.([^,)]+)/)[1];
    const s = orExpr.match(/source\.gt\.([^,)]+)/)[1];
    const sid = orExpr.match(/source_id\.gt\.([^,)]+)/)[1];
    filtered = filtered.filter(
      (r) =>
        r.created_at > c ||
        (r.created_at === c &&
          (r.source > s || (r.source === s && r.source_id > sid)))
    );
  } else {
    const since = (p.get("created_at") || "").replace(/^gt\./, "");
    filtered = filtered.filter((r) => r.created_at > since);
  }
  filtered.sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1
    : a.source < b.source ? -1 : a.source > b.source ? 1
    : a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0
  );
  return filtered.slice(0, Number(p.get("limit") || 500));
}

/** N synthetic listings, `stepMs` apart from base, all within the window. */
function manyListings(n, base = "2026-09-24T01:00:00.000Z", stepMs = 1000) {
  const t0 = Date.parse(base);
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      source: "ebay",
      source_id: `m${i}`,
      title: `LEGO set number ${i}`,
      price_cad: 10,
      url: `https://ebay.ca/itm/m${i}`,
      image: null,
      location: null,
      posted_at: new Date(t0 + i * stepMs).toISOString(),
      niche: null,
      created_at: new Date(t0 + i * stepMs).toISOString(),
    });
  }
  return rows;
}

/** fetchImpl serving only the listings endpoint (for defaultLoadListings). */
function listingsFetch(rows) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    assert.equal(u.pathname, "/rest/v1/listings");
    return {
      status: 200,
      ok: true,
      json: async () => fakeListingsPage(rows, url),
      text: async () => "",
    };
  };
}

// ---------------------------------------------------------------- env setup

let savedEnv;
beforeEach(() => {
  savedEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
  };
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.RESEND_API_KEY = "test-resend-key";
  delete process.env.ALERT_FROM;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------- tests

describe("dispatch-alerts", () => {
  it("run 1: exactly one email per new match", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: baseSearches(),
      listings: baseListings(),
      runs: [{ ran_at: T0, ok: true }],
    });
    const res = await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const body = bodyOf(res);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.listings_seen, 5);
    assert.equal(body.matches, 3); // s1×e1, s2×e2, s4×e3
    assert.equal(body.emails_sent, 2); // u3 lookup fails -> error, no send
    assert.equal(world.outbox.length, 2);
    assert.deepEqual(
      world.outbox.map((e) => e.to).sort(),
      ["user1@example.com", "user2@example.com"]
    );
    assert.equal(body.errors.length, 1);
    assert.match(body.errors[0].error, /recipient lookup failed/);
    // Dedupe ledger holds all three matches (insert-then-send).
    assert.equal(world.alerts.size, 3);
    assert.ok(world.alerts.has("s1|ebay|e1"));
    assert.ok(world.alerts.has("s2|ebay|e2"));
    assert.ok(world.alerts.has("s4|ebay|e3"));
    // A run record was written.
    assert.equal(world.runs.length, 2);
  });

  it("run 2 (re-run): zero duplicate emails", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: baseSearches(),
      listings: baseListings(),
      runs: [{ ran_at: T0, ok: true }],
    });
    await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const outboxAfterRun1 = world.outbox.length;
    const res = await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const body = bodyOf(res);
    assert.equal(body.emails_sent, 0);
    assert.equal(world.outbox.length, outboxAfterRun1);
    assert.equal(body.errors.length, 0);
  });

  it("run 3: a genuinely new listing sends exactly one new email", async () => {
    const listings = baseListings();
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: baseSearches(),
      listings,
      runs: [{ ran_at: T0, ok: true }],
    });
    await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    listings.push({
      source: "ebay", source_id: "e9", title: "iPod Classic 5th gen 30GB",
      price_cad: 99.99, url: "https://ebay.ca/itm/e9", image: null,
      location: "Ottawa", posted_at: T1, niche: "ipod",
      created_at: "2026-09-24T01:30:00.000Z",
    });
    const res = await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const body = bodyOf(res);
    assert.equal(body.emails_sent, 1);
    assert.equal(world.outbox.length, 3);
    assert.equal(world.outbox[2].to, "user1@example.com");
    assert.match(world.outbox[2].subject, /iPod Classic 5th gen/);
  });

  it("first run bootstraps the watermark and sends nothing", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: baseSearches(),
      listings: baseListings(),
      runs: [],
    });
    const res = await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const body = bodyOf(res);
    assert.equal(res.statusCode, 200);
    assert.equal(body.bootstrapped, true);
    assert.equal(world.outbox.length, 0);
    assert.equal(world.alerts.size, 0);
    assert.equal(world.runs.length, 1);
    assert.equal(world.runs[0].ran_at, NOW.toISOString());
  });

  it("missing env vars -> clean config_error, no network calls", async () => {
    const { world, fetchImpl, loadListings } = makeWorld();
    delete process.env.RESEND_API_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const body = bodyOf(res);
    assert.equal(res.statusCode, 500);
    assert.equal(body.error, "config_error");
    assert.match(body.detail, /RESEND_API_KEY/);
    assert.match(body.detail, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.equal(world.fetchCalls, 0);
    assert.equal(world.outbox.length, 0);
  });

  it("resend failure after dedupe insert -> no double-send on re-run", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: baseSearches(),
      listings: baseListings(),
      runs: [{ ran_at: T0, ok: true }],
      resendFailFor: new Set(["user1@example.com"]),
    });
    const r1 = await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const b1 = bodyOf(r1);
    assert.equal(b1.emails_sent, 1); // only user2's email got out
    assert.equal(world.outbox.length, 1);
    assert.ok(world.alerts.has("s1|ebay|e1")); // dedupe row kept
    assert.equal(b1.errors.length, 2); // resend fail + u3 lookup fail

    world.resendFailFor.clear(); // resend recovers
    const r2 = await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const b2 = bodyOf(r2);
    // No retry of the failed send: the dedupe row means "already handled".
    assert.equal(b2.emails_sent, 0);
    assert.equal(world.outbox.length, 1);
  });

  it("supabase outage -> clean run_error, nothing sent", async () => {
    const { world, fetchImpl, loadListings } = makeWorld();
    const broken = async () => {
      throw new Error("connection refused");
    };
    const res = await dispatchAlerts({ fetchImpl: broken, now: NOW, loadListings });
    const body = bodyOf(res);
    assert.equal(res.statusCode, 500);
    assert.equal(body.error, "run_error");
    assert.equal(world.outbox.length, 0);
  });
});

describe("matchesSearch", () => {
  const listing = (over = {}) =>
    Object.assign(
      { source: "ebay", source_id: "x", title: "Apple iPod Classic 7th Gen", price_cad: 150, niche: "ipod" },
      over
    );
  const search = (over = {}) =>
    Object.assign(
      { id: "s", user_id: "u", keywords: "ipod", niche: null, max_price_cad: null, marketplaces: [] },
      over
    );

  it("is case-insensitive and matches any comma-separated term", () => {
    assert.equal(matchesSearch(search({ keywords: "CLASSIC, zune" }), listing()), true);
    assert.equal(matchesSearch(search({ keywords: "zune, walkman" }), listing()), false);
  });
  it("empty keywords never match", () => {
    assert.equal(matchesSearch(search({ keywords: "  " }), listing()), false);
  });
  it("price cap: over-cap skipped, unknown price with cap skipped", () => {
    assert.equal(matchesSearch(search({ max_price_cad: 100 }), listing()), false);
    assert.equal(
      matchesSearch(search({ max_price_cad: 100 }), listing({ price_cad: null })),
      false
    );
    assert.equal(
      matchesSearch(search(), listing({ price_cad: null })),
      true
    );
  });
  it("marketplace allow-list filters", () => {
    assert.equal(
      matchesSearch(search({ marketplaces: ["kijiji"] }), listing()),
      false
    );
    assert.equal(
      matchesSearch(search({ marketplaces: ["ebay"] }), listing()),
      true
    );
  });
  it("niche only filters when both sides declare one", () => {
    assert.equal(
      matchesSearch(search({ niche: "lego" }), listing({ niche: "ipod" })),
      false
    );
    assert.equal(matchesSearch(search({ niche: "ipod" }), listing()), true);
    assert.equal(
      matchesSearch(search({ niche: "ipod" }), listing({ niche: null })),
      true
    );
  });
});

describe("defaultLoadListings pagination", () => {
  const BASE = "https://test.supabase.co";
  const KEY = "test-key";
  const SINCE = "2026-09-24T00:00:00.000Z";
  const CUTOFF = "2026-09-24T02:00:00.000Z"; // == NOW in the suite

  function keys(rows) {
    return rows.map((r) => `${r.source}|${r.source_id}`);
  }

  it("drains multiple full pages: 1200 rows, none lost, none duplicated", async () => {
    const rows = await defaultLoadListings(
      listingsFetch(manyListings(1200)),
      BASE,
      KEY,
      SINCE,
      CUTOFF
    );
    assert.equal(rows.length, 1200);
    assert.equal(new Set(keys(rows)).size, 1200);
    assert.equal(rows.truncated, false);
  });

  it("a created_at tie straddling the 500-row page boundary is not lost", async () => {
    const listings = manyListings(1200);
    // Force a tie across the first page boundary: rows 498..502 share one
    // timestamp. A timestamp-only cursor would drop the overflow half.
    const tie = listings[498].created_at;
    for (const i of [499, 500, 501, 502]) listings[i].created_at = tie;
    const rows = await defaultLoadListings(
      listingsFetch(listings),
      BASE,
      KEY,
      SINCE,
      CUTOFF
    );
    assert.equal(rows.length, 1200);
    assert.equal(new Set(keys(rows)).size, 1200);
    assert.equal(rows.truncated, false);
  });

  it("rows past the cutoff are excluded and the drain still completes", async () => {
    const listings = manyListings(600);
    // Push 100 rows past the cutoff.
    for (let i = 500; i < 600; i++) {
      listings[i].created_at = "2026-09-24T03:00:00.000Z";
      listings[i].posted_at = "2026-09-24T03:00:00.000Z";
    }
    const rows = await defaultLoadListings(
      listingsFetch(listings),
      BASE,
      KEY,
      SINCE,
      CUTOFF
    );
    assert.equal(rows.length, 500);
    assert.ok(rows.every((r) => r.created_at <= CUTOFF));
    assert.equal(rows.truncated, false);
  });

  it("empty window -> empty array, not truncated", async () => {
    const rows = await defaultLoadListings(
      listingsFetch([]),
      BASE,
      KEY,
      SINCE,
      CUTOFF
    );
    assert.deepEqual([...rows], []);
    assert.equal(rows.truncated, false);
  });

  it("page budget exhaustion (5000+ rows) is flagged, not silent", async () => {
    // 100ms spacing keeps all 5001 rows inside the window.
    const rows = await defaultLoadListings(
      listingsFetch(manyListings(5001, "2026-09-24T01:00:00.000Z", 100)),
      BASE,
      KEY,
      SINCE,
      CUTOFF
    );
    assert.equal(rows.length, 5000); // 10 pages x 500
    assert.equal(new Set(keys(rows)).size, 5000);
    assert.equal(rows.truncated, true);
  });

  it("integration: dispatchAlerts with the real loader sees all 600 listings", async () => {
    // No injected loadListings -> the default paginated loader runs
    // against the fake PostgREST endpoint wired into makeWorld.
    const { world, fetchImpl } = makeWorld({
      searches: baseSearches(),
      listings: manyListings(600),
      runs: [{ ran_at: T0, ok: true }],
    });
    const res = await dispatchAlerts({ fetchImpl, now: NOW }); // no loadListings seam
    const body = bodyOf(res);
    assert.equal(res.statusCode, 200);
    assert.equal(body.listings_seen, 600); // old code would report 500
    assert.equal(body.matches, 600); // all match s2 ("lego", u2)
    assert.equal(body.emails_sent, 600);
    assert.equal(world.outbox.length, 600);
    assert.equal(body.truncated, false);
    assert.deepEqual(body.errors, []);
  });
});
