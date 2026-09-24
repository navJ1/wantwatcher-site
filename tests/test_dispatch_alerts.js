/**
 * Unit tests for the alert dispatcher (netlify/functions/dispatch-alerts.js).
 *
 * No network, no real credentials: Supabase (PostgREST + Auth admin) and
 * Resend are faked behind one injected fetchImpl; listings come through
 * the deps.loadListings seam. Fixtures only — no real users.
 * Run: node --test tests/test_dispatch_alerts.js
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  dispatchAlerts,
  matchesSearch,
} = require("../netlify/functions/dispatch-alerts.js");

// ---------------------------------------------------------------- fixtures

const T0 = "2026-09-24T00:00:00.000Z"; // prior run cutoff
const T1 = "2026-09-24T01:00:00.000Z"; // listing creation time
const NOW = new Date("2026-09-24T02:00:00.000Z");

function baseSearches() {
  return [
    { id: "s1", user_id: "u1", keywords: "ipod classic", niche: "ipod", max_price_cad: 250, marketplaces: ["ebay", "kijiji"], enabled: true },
    { id: "s2", user_id: "u2", keywords: "lego", niche: null, max_price_cad: null, marketplaces: [], enabled: true },
    { id: "s3", user_id: "u1", keywords: "   ", niche: null, max_price_cad: null, marketplaces: [], enabled: true }, // malformed: no terms
    { id: "s4", user_id: "u3", keywords: "gameboy", niche: null, max_price_cad: null, marketplaces: ["ebay"], enabled: true },
  ];
}

// Small builders for the hardening tests (always enabled unless overridden).
function searchWith(over) {
  return Object.assign(
    { id: "sx", user_id: "u1", keywords: "ipod", niche: null, max_price_cad: null, marketplaces: [], enabled: true },
    over
  );
}
function listingWith(over) {
  return Object.assign(
    { source: "ebay", source_id: "lx", title: "Apple iPod Classic 7th Gen 160GB", price_cad: 150, url: "https://ebay.ca/itm/lx", image: null, location: null, posted_at: T1, niche: "ipod", created_at: T1 },
    over
  );
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
 *           runs: [{ran_at, ok, ...}], outbox: [], resendFailFor: Set<to>,
 *           resendThrowFor: Set<to> (fetch rejects = network down),
 *           ignoreEnabledFilter: true (saved_searches returns disabled rows
 *             too, to test the dispatcher's defensive filter) }
 */
function makeWorld(state = {}) {
  const w = {
    searches: state.searches || [],
    listings: state.listings || [],
    alerts: state.alerts || new Set(),
    runs: state.runs || [],
    outbox: [],
    resendFailFor: state.resendFailFor || new Set(),
    resendThrowFor: state.resendThrowFor || new Set(),
    ignoreEnabledFilter: !!state.ignoreEnabledFilter,
    fetchCalls: 0,
  };

  async function fetchImpl(url, opts = {}) {
    w.fetchCalls++;
    const method = (opts.method || "GET").toUpperCase();
    const u = new URL(url, "https://test.supabase.co");

    // --- Resend ---
    if (u.hostname === "api.resend.com") {
      const email = JSON.parse(opts.body);
      if (w.resendThrowFor.has(email.to)) {
        throw new Error("socket hang up (simulated resend outage)");
      }
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
      // Mirror real PostgREST: the dispatcher queries enabled=eq.true, so
      // disabled rows are filtered server-side. ignoreEnabledFilter lets a
      // test leak a disabled row through to exercise the client-side guard.
      let rows = w.searches;
      if (!w.ignoreEnabledFilter && u.searchParams.get("enabled") === "eq.true") {
        rows = rows.filter((s) => s.enabled === true);
      }
      return fakeResp(200, rows);
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

  it("garbage price + cap -> no alert and no dedupe row", async () => {
    const listings = baseListings().concat([
      {
        source: "ebay", source_id: "e8", title: "iPod classic 160GB thin",
        price_cad: "contact", url: "https://ebay.ca/itm/e8", image: null,
        location: null, posted_at: T1, niche: "ipod", created_at: T1,
      },
    ]);
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: baseSearches(),
      listings,
      runs: [{ ran_at: T0, ok: true }],
    });
    const res = await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const body = bodyOf(res);
    assert.equal(body.ok, true);
    // s1 has max_price_cad 250: the unparseable price must not match it.
    assert.ok(!world.alerts.has("s1|ebay|e8"));
    assert.ok(!world.outbox.some((e) => /160GB thin/.test(e.subject)));
  });

  it("garbage price + no cap -> email says 'price not listed', never C$NaN", async () => {
    const listings = baseListings().concat([
      {
        source: "ebay", source_id: "e7", title: "LEGO Technic crane",
        price_cad: "make an offer", url: "https://ebay.ca/itm/e7",
        image: null, location: null, posted_at: T1, niche: "lego",
        created_at: T1,
      },
    ]);
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: baseSearches(),
      listings,
      runs: [{ ran_at: T0, ok: true }],
    });
    const res = await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const body = bodyOf(res);
    assert.equal(body.ok, true);
    const mail = world.outbox.find((e) => /Technic/.test(e.subject));
    assert.ok(mail, "expected an alert email for the garbage-priced listing");
    assert.match(mail.html, /price not listed/);
    assert.doesNotMatch(mail.html, /NaN/);
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
  it("missing keywords (undefined) never match", () => {
    assert.equal(matchesSearch(search({ keywords: undefined }), listing()), false);
    assert.equal(matchesSearch(search({ keywords: null }), listing()), false);
  });
  it("non-numeric max_price_cad is treated as no cap", () => {
    assert.equal(
      matchesSearch(search({ max_price_cad: "not-a-number" }), listing({ price_cad: 99999 })),
      true
    );
  });
  it("unknown niche on the search filters differently-niched listings", () => {
    assert.equal(
      matchesSearch(search({ niche: "does-not-exist" }), listing({ niche: "ipod" })),
      false
    );
    assert.equal(
      matchesSearch(search({ niche: "does-not-exist" }), listing({ niche: null })),
      true
    );
  });
  it("unparseable prices never satisfy a cap", () => {
    // NaN > cap is false, so without an explicit finite check these
    // garbage prices would silently match every cap.
    for (const bad of [
      "contact",
      "N/A",
      "",
      "   ",
      "$",
      NaN,
      Infinity,
      -Infinity,
    ]) {
      assert.equal(
        matchesSearch(
          search({ max_price_cad: 250 }),
          listing({ price_cad: bad })
        ),
        false,
        `price ${JSON.stringify(String(bad))} must not pass the cap`
      );
    }
  });
  it("unparseable price with no cap still matches", () => {
    assert.equal(
      matchesSearch(search(), listing({ price_cad: "make an offer" })),
      true
    );
  });
  it("numeric-string prices still work with caps", () => {
    assert.equal(
      matchesSearch(
        search({ max_price_cad: 250 }),
        listing({ price_cad: "199.99" })
      ),
      true
    );
    assert.equal(
      matchesSearch(
        search({ max_price_cad: 100 }),
        listing({ price_cad: "199.99" })
      ),
      false
    );
  });
});

// ---------------------------------------------------------------- hardening

describe("dispatch-alerts: enabled flag", () => {
  it("enabled=false hunts are excluded by the query and never alert", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [
        searchWith({ id: "on", keywords: "ipod" }),
        searchWith({ id: "off", keywords: "ipod", enabled: false }),
      ],
      listings: [listingWith({ source_id: "l1" })],
      runs: [{ ran_at: T0, ok: true }],
    });
    const body = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    assert.equal(body.matches, 1);
    assert.equal(body.emails_sent, 1);
    assert.equal(world.outbox.length, 1);
    assert.ok(world.alerts.has("on|ebay|l1"));
    assert.ok(!world.alerts.has("off|ebay|l1"));
    assert.equal(body.errors.length, 0);
  });

  it("a disabled search that leaks through the loader is still skipped", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [searchWith({ id: "off", keywords: "ipod", enabled: false })],
      listings: [listingWith({ source_id: "l1" })],
      runs: [{ ran_at: T0, ok: true }],
      ignoreEnabledFilter: true, // simulate the query filter failing
    });
    const body = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    assert.equal(body.matches, 0);
    assert.equal(body.emails_sent, 0);
    assert.equal(world.outbox.length, 0);
    assert.equal(world.alerts.size, 0);
  });
});

describe("dispatch-alerts: watermark", () => {
  it("a failed prior run does not count as a watermark: bootstrap again, send nothing", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: baseSearches(),
      listings: baseListings(),
      runs: [{ ran_at: T0, ok: false, errors: [{ error: "boom" }] }],
    });
    const res = await dispatchAlerts({ fetchImpl, now: NOW, loadListings });
    const body = bodyOf(res);
    assert.equal(body.bootstrapped, true);
    assert.equal(world.outbox.length, 0);
    assert.equal(world.alerts.size, 0);
    assert.equal(world.runs.length, 2); // failed run + new bootstrap
  });

  it("the newest successful run is the watermark, not an older one", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [searchWith({ id: "on", keywords: "ipod" })],
      listings: [
        listingWith({ source_id: "old", created_at: "2026-09-24T00:30:00.000Z" }),
        listingWith({ source_id: "new", created_at: "2026-09-24T01:30:00.000Z" }),
      ],
      runs: [
        { ran_at: T0, ok: true },
        { ran_at: "2026-09-24T01:00:00.000Z", ok: true },
      ],
    });
    const body = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    assert.equal(body.since, "2026-09-24T01:00:00.000Z");
    assert.equal(body.listings_seen, 1);
    assert.equal(body.emails_sent, 1);
    assert.ok(world.alerts.has("on|ebay|new"));
    assert.ok(!world.alerts.has("on|ebay|old"));
  });

  it("listings outside the (since, cutoff] window never alert", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [searchWith({ id: "on", keywords: "ipod" })],
      listings: [
        listingWith({ source_id: "at-cutoff", created_at: T0 }), // == since, excluded
        listingWith({ source_id: "future", created_at: "2026-09-24T03:00:00.000Z" }), // > now
        listingWith({ source_id: "inwin", created_at: T1 }),
      ],
      runs: [{ ran_at: T0, ok: true }],
    });
    const body = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    assert.equal(body.listings_seen, 1);
    assert.equal(body.emails_sent, 1);
    assert.ok(world.alerts.has("on|ebay|inwin"));
  });
});

describe("dispatch-alerts: exact-once dedupe", () => {
  it("three consecutive runs deliver each match exactly once", async () => {
    const listings = [listingWith({ source_id: "a", created_at: T1 })];
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [searchWith({ id: "on", keywords: "ipod" })],
      listings,
      runs: [{ ran_at: T0, ok: true }],
    });
    const now1 = new Date("2026-09-24T01:30:00.000Z");
    const now2 = new Date("2026-09-24T02:00:00.000Z");
    const now3 = new Date("2026-09-24T02:30:00.000Z");

    const b1 = bodyOf(await dispatchAlerts({ fetchImpl, now: now1, loadListings }));
    assert.equal(b1.emails_sent, 1);
    assert.equal(b1.errors.length, 0);

    // Re-run with the same window: 409 dedupe hits, zero sends.
    const b1r = bodyOf(await dispatchAlerts({ fetchImpl, now: now1, loadListings }));
    assert.equal(b1r.emails_sent, 0);
    assert.equal(b1r.errors.length, 0);

    listings.push(listingWith({ source_id: "b", created_at: "2026-09-24T01:45:00.000Z" }));
    const b2 = bodyOf(await dispatchAlerts({ fetchImpl, now: now2, loadListings }));
    assert.equal(b2.since, now1.toISOString());
    assert.equal(b2.emails_sent, 1); // only b
    assert.ok(world.alerts.has("on|ebay|b"));

    const b3 = bodyOf(await dispatchAlerts({ fetchImpl, now: now3, loadListings }));
    assert.equal(b3.emails_sent, 0);
    assert.equal(b3.errors.length, 0);

    assert.equal(world.outbox.length, 2);
    assert.equal(world.alerts.size, 2);
  });
});

describe("dispatch-alerts: resend failures", () => {
  it("resend fetch throwing (network down) -> logged, no crash, dedupe kept, no retry", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [searchWith({ id: "on", keywords: "ipod" })],
      listings: [listingWith({ source_id: "l1" })],
      runs: [{ ran_at: T0, ok: true }],
      resendThrowFor: new Set(["user1@example.com"]),
    });
    const b1 = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    assert.equal(b1.emails_sent, 0);
    assert.equal(world.outbox.length, 0);
    assert.ok(world.alerts.has("on|ebay|l1")); // dedupe row kept
    assert.equal(b1.errors.length, 1);
    assert.match(b1.errors[0].error, /resend failed/);

    world.resendThrowFor.clear(); // resend recovers
    const b2 = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    // No retry of the failed send: insert-then-send means at most one
    // missed email, never a duplicate.
    assert.equal(b2.emails_sent, 0);
    assert.equal(world.outbox.length, 0);
    assert.equal(b2.errors.length, 0);
  });
});

describe("dispatch-alerts: malformed saved_search rows", () => {
  it("missing/null keywords never match and never alert", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [
        searchWith({ id: "nokey" }),
        searchWith({ id: "nullkey", keywords: null }),
      ],
      listings: [listingWith({ source_id: "l1" })],
      runs: [{ ran_at: T0, ok: true }],
    });
    delete world.searches[0].keywords; // column missing entirely
    const body = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    assert.equal(body.matches, 0);
    assert.equal(body.emails_sent, 0);
    assert.equal(world.outbox.length, 0);
    assert.equal(world.alerts.size, 0);
  });

  it("non-numeric max_price_cad behaves as no cap", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [searchWith({ id: "bcap", max_price_cad: "not-a-number" })],
      listings: [listingWith({ source_id: "l1", price_cad: 99999 })],
      runs: [{ ran_at: T0, ok: true }],
    });
    const body = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    assert.equal(body.matches, 1);
    assert.equal(body.emails_sent, 1);
  });

  it("unknown niche on the search filters out differently-niched listings", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [searchWith({ id: "wn", keywords: "ipod", niche: "does-not-exist" })],
      listings: [
        listingWith({ source_id: "l1", niche: "ipod" }),
        listingWith({ source_id: "l2", niche: null }),
      ],
      runs: [{ ran_at: T0, ok: true }],
    });
    const body = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    // l1: both sides set, unequal -> filtered. l2: listing side unset -> passes.
    assert.equal(body.matches, 1);
    assert.equal(body.emails_sent, 1);
    assert.ok(world.alerts.has("wn|ebay|l2"));
    assert.ok(!world.alerts.has("wn|ebay|l1"));
  });
});

describe("dispatch-alerts: marketplace filtering", () => {
  it("ebay-only hunts never alert on kijiji listings and vice versa", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [
        searchWith({ id: "ebay-only", keywords: "ipod", marketplaces: ["ebay"] }),
        searchWith({ id: "kijiji-only", keywords: "ipod", marketplaces: ["kijiji"] }),
      ],
      listings: [
        listingWith({ source: "ebay", source_id: "e1" }),
        listingWith({ source: "kijiji", source_id: "k1" }),
      ],
      runs: [{ ran_at: T0, ok: true }],
    });
    const body = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    assert.equal(body.matches, 2);
    assert.equal(body.emails_sent, 2);
    assert.ok(world.alerts.has("ebay-only|ebay|e1"));
    assert.ok(world.alerts.has("kijiji-only|kijiji|k1"));
    assert.ok(!world.alerts.has("ebay-only|kijiji|k1"));
    assert.ok(!world.alerts.has("kijiji-only|ebay|e1"));
  });

  it("a hunt with an empty marketplace list sees every marketplace", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [searchWith({ id: "any", keywords: "ipod", marketplaces: [] })],
      listings: [
        listingWith({ source: "ebay", source_id: "e1" }),
        listingWith({ source: "kijiji", source_id: "k1" }),
      ],
      runs: [{ ran_at: T0, ok: true }],
    });
    const body = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    assert.equal(body.matches, 2);
    assert.equal(body.emails_sent, 2);
  });
});

describe("dispatch-alerts: niche filtering", () => {
  it("niche-scoped hunts only alert within their niche", async () => {
    const { world, fetchImpl, loadListings } = makeWorld({
      searches: [
        searchWith({ id: "n-ipod", keywords: "classic", niche: "ipod" }),
        searchWith({ id: "n-lego", keywords: "classic", niche: "lego" }),
        searchWith({ id: "n-any", keywords: "classic", niche: null }),
      ],
      listings: [
        listingWith({ source_id: "l1", title: "iPod Classic 7th Gen", niche: "ipod" }),
        listingWith({ source_id: "l2", title: "LEGO Classic bricks box", niche: "lego" }),
        listingWith({ source_id: "l3", title: "Classic car model kit", niche: null }),
      ],
      runs: [{ ran_at: T0, ok: true }],
    });
    const body = bodyOf(await dispatchAlerts({ fetchImpl, now: NOW, loadListings }));
    // n-ipod x l1,l3; n-lego x l2,l3; n-any x l1,l2,l3 = 7 matches
    assert.equal(body.matches, 7);
    assert.equal(body.emails_sent, 7);
    assert.equal(world.outbox.length, 7);
    assert.ok(world.alerts.has("n-ipod|ebay|l1"));
    assert.ok(!world.alerts.has("n-ipod|ebay|l2")); // niche mismatch
    assert.ok(world.alerts.has("n-ipod|ebay|l3")); // listing niche unset -> passes
    assert.ok(world.alerts.has("n-any|ebay|l3")); // search niche unset -> passes
  });
});
