/**
 * Unit tests for the listing engine: netlify/functions/fetch-listings.js
 * and the Discord alert path in netlify/functions/dispatch-alerts.js.
 *
 * No network, no real credentials: fetch is injected and every external
 * call is faked. Run: node --test tests/test_fetch_listings.js
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchListings,
  mapEbayItem,
  parsePrice,
  fetchKijijiListings,
} = require("../netlify/functions/fetch-listings.js");
const {
  buildDiscordMessage,
  sendDiscord,
  dispatchAlerts,
} = require("../netlify/functions/dispatch-alerts.js");

// ---------------------------------------------------------------- helpers

function fakeResp(status, jsonBody) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => jsonBody,
    text: async () => (jsonBody === undefined ? "" : JSON.stringify(jsonBody)),
  };
}

/** Router fetch stub: match on URL substring -> response or throw. */
function makeFetch(routes, calls) {
  return async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) return handler(url, opts);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const SEARCHES = [
  {
    keywords: "ipod classic",
    max_price_cad: 200,
    marketplaces: ["ebay"],
    niche: "vintage-tech",
  },
];

function ebayItem(overrides = {}) {
  return Object.assign(
    {
      itemId: "v1|123|0",
      title: "Apple iPod Classic 160GB 7th Gen - Tested Working",
      price: { value: "179.99", currency: "CAD" },
      itemWebUrl: "https://www.ebay.ca/itm/123",
      image: { imageUrl: "https://i.ebayimg.com/img.jpg" },
      itemLocation: { city: "Toronto", stateOrProvince: "ON", country: "CA" },
      itemCreationDate: "2026-09-24T10:00:00.000Z",
    },
    overrides
  );
}

const FULL_ENV = {
  SUPABASE_URL: "https://xyz.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  EBAY_APP_ID: "appid",
  EBAY_CERT_ID: "certid",
};

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, FULL_ENV);
});
afterEach(() => {
  process.env = savedEnv;
});

// ---------------------------------------------------------------- parsePrice

describe("parsePrice", () => {
  it("parses a normal CAD price", () => {
    assert.equal(parsePrice({ value: "179.99", currency: "CAD" }), 179.99);
  });
  it("returns null for missing/invalid prices", () => {
    assert.equal(parsePrice(null), null);
    assert.equal(parsePrice(undefined), null);
    assert.equal(parsePrice({}), null);
    assert.equal(parsePrice({ value: "contact", currency: "CAD" }), null);
    assert.equal(parsePrice({ value: "NaN", currency: "CAD" }), null);
    assert.equal(parsePrice({ value: "-5", currency: "CAD" }), null);
    assert.equal(parsePrice({ value: "0", currency: "CAD" }), null);
    assert.equal(parsePrice("179.99"), null);
  });
});

// ---------------------------------------------------------------- mapEbayItem

describe("mapEbayItem", () => {
  it("maps an eBay itemSummary to a listings row", () => {
    const row = mapEbayItem(ebayItem(), "vintage-tech");
    assert.deepEqual(row, {
      source: "ebay",
      source_id: "v1|123|0",
      title: "Apple iPod Classic 160GB 7th Gen - Tested Working",
      price_cad: 179.99,
      url: "https://www.ebay.ca/itm/123",
      image: "https://i.ebayimg.com/img.jpg",
      location: "Toronto, ON, CA",
      posted_at: "2026-09-24T10:00:00.000Z",
      niche: "vintage-tech",
    });
  });
  it("nulls out unknown prices and missing optionals", () => {
    const row = mapEbayItem(
      ebayItem({ price: { value: "contact", currency: "CAD" }, image: null }),
      null
    );
    assert.equal(row.price_cad, null);
    assert.equal(row.image, null);
    assert.equal(row.location, "Toronto, ON, CA");
    assert.equal(row.niche, null);
  });
  it("handles missing location gracefully", () => {
    const row = mapEbayItem(ebayItem({ itemLocation: undefined }), "x");
    assert.equal(row.location, null);
  });
});

// ---------------------------------------------------------------- kijiji stub

describe("fetchKijijiListings (stub)", () => {
  it("returns [] and never fabricates listings", () => {
    const rows = fetchKijijiListings({ keywords: "ipod classic" });
    assert.deepEqual(rows, []);
  });
});

// ---------------------------------------------------------------- fetchListings no-op

describe("fetchListings missing-env no-op", () => {
  it("returns {ok:true, skipped:true} when env vars are unset", async () => {
    delete process.env.EBAY_APP_ID;
    delete process.env.SUPABASE_URL;
    let fetched = false;
    const res = await fetchListings({
      fetchImpl: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.skipped, true);
    assert.ok(body.reason.includes("EBAY_APP_ID"));
    assert.equal(fetched, false);
  });
});

// ---------------------------------------------------------------- fetchListings happy path

function happyRoutes(calls, { searches = SEARCHES, items = [ebayItem()] } = {}) {
  return [
    [
      "/rest/v1/saved_searches",
      () => fakeResp(200, searches),
    ],
    [
      "/identity/v1/oauth2/token",
      (url, opts) => {
        // client-credentials grant, Basic appId:certId
        assert.ok(
          String(opts.headers.Authorization).startsWith("Basic "),
          "token request uses Basic auth"
        );
        assert.ok(
          String(opts.body).includes("grant_type=client_credentials"),
          "token request uses client-credentials grant"
        );
        return fakeResp(200, { access_token: "tok", expires_in: 7200 });
      },
    ],
    [
      "/buy/browse/v1/item_summary/search",
      (url, opts) => {
        assert.equal(opts.headers["X-EBAY-C-MARKETPLACE-ID"], "EBAY_CA");
        assert.equal(opts.headers.Authorization, "Bearer tok");
        const u = new URL(url);
        assert.ok(u.searchParams.get("q").length > 0, "query sent");
        assert.ok(
          u.searchParams.get("filter").includes("priceCurrency:CAD"),
          "CAD price filter sent"
        );
        // one page: fewer items than the limit ends pagination
        return fakeResp(200, { itemSummaries: items, total: items.length });
      },
    ],
    [
      "/rest/v1/listings",
      (url, opts) => {
        assert.equal(opts.method, "POST");
        assert.ok(
          String(opts.headers.Prefer).includes("resolution=merge-duplicates"),
          "upsert uses merge-duplicates"
        );
        assert.ok(
          url.includes("on_conflict=source%2Csource_id") ||
            url.includes("on_conflict=source,source_id"),
          "upsert conflicts on (source, source_id)"
        );
        return fakeResp(201, []);
      },
    ],
  ];
}

describe("fetchListings happy path", () => {
  it("sweeps ebay searches and upserts listing rows", async () => {
    const calls = [];
    const fetchImpl = makeFetch(happyRoutes(calls), calls);
    const res = await fetchListings({ fetchImpl });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, {
      ok: true,
      searches_seen: 1,
      ebay_searches: 1,
      kijiji_searches: 0,
      rows_upserted: 1,
      errors: [],
    });
    const upsert = calls.find((c) => c.url.includes("/rest/v1/listings"));
    const rows = JSON.parse(upsert.opts.body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "ebay");
    assert.equal(rows[0].source_id, "v1|123|0");
    assert.equal(rows[0].price_cad, 179.99);
  });

  it("applies max_price_cad as an eBay price filter", async () => {
    const calls = [];
    const fetchImpl = makeFetch(happyRoutes(calls), calls);
    await fetchListings({ fetchImpl });
    const search = calls.find((c) =>
      c.url.includes("/buy/browse/v1/item_summary/search")
    );
    const filter = new URL(search.url).searchParams.get("filter");
    assert.ok(filter.includes("price:[..200.00]"), `filter was: ${filter}`);
  });

  it("kijiji-only searches run the stub and upsert nothing", async () => {
    const calls = [];
    const fetchImpl = makeFetch(
      happyRoutes(calls, {
        searches: [
          {
            keywords: "ipod",
            max_price_cad: null,
            marketplaces: ["kijiji"],
            niche: "vintage-tech",
          },
        ],
      }),
      calls
    );
    const res = await fetchListings({ fetchImpl });
    const body = JSON.parse(res.body);
    assert.equal(body.ebay_searches, 0);
    assert.equal(body.kijiji_searches, 1);
    assert.equal(body.rows_upserted, 0);
    assert.ok(!calls.some((c) => c.url.includes("/rest/v1/listings")));
  });

  it("one failing search does not kill the sweep", async () => {
    const calls = [];
    const routes = happyRoutes(calls, {
      searches: [
        { keywords: "boom", max_price_cad: null, marketplaces: ["ebay"], niche: null },
        { keywords: "ipod classic", max_price_cad: 200, marketplaces: ["ebay"], niche: "vintage-tech" },
      ],
    });
    // first search's eBay call fails
    let n = 0;
    routes[2][1] = () => {
      n++;
      if (n === 1) throw new Error("ebay exploded");
      return fakeResp(200, { itemSummaries: [ebayItem()], total: 1 });
    };
    const res = await fetchListings({ fetchImpl: makeFetch(routes, calls) });
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].keywords, "boom");
    assert.equal(body.rows_upserted, 1);
  });

  it("token failure returns a clean 500, nothing half-written", async () => {
    const calls = [];
    const routes = happyRoutes(calls);
    routes[1][1] = () => fakeResp(401, { error: "invalid_client" });
    const res = await fetchListings({ fetchImpl: makeFetch(routes, calls) });
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.ok(body.detail.includes("ebay token 401"));
    assert.ok(!calls.some((c) => c.url.includes("/rest/v1/listings")));
  });
});

// ---------------------------------------------------------------- discord

describe("buildDiscordMessage", () => {
  it("builds a readable embed payload", () => {
    const listing = {
      source: "ebay",
      source_id: "v1|123|0",
      title: "iPod Classic",
      price_cad: 179.99,
      url: "https://www.ebay.ca/itm/123",
      location: "Toronto, ON",
    };
    const msg = buildDiscordMessage({ keywords: "ipod classic" }, listing);
    assert.ok(msg.content.includes("ipod classic"));
    assert.equal(msg.embeds.length, 1);
    assert.equal(msg.embeds[0].title, "iPod Classic");
    assert.equal(msg.embeds[0].url, "https://www.ebay.ca/itm/123");
    assert.ok(msg.embeds[0].description.includes("C$179.99"));
    assert.ok(msg.embeds[0].description.includes("ebay"));
  });
  it("never renders C$NaN for bad prices", () => {
    const msg = buildDiscordMessage(
      { keywords: "x" },
      { title: "t", price_cad: "contact", url: "u", source: "ebay" }
    );
    assert.ok(!msg.embeds[0].description.includes("NaN"));
    assert.ok(msg.embeds[0].description.includes("price not listed"));
  });
});

describe("sendDiscord", () => {
  it("POSTs JSON and accepts 204", async () => {
    const calls = [];
    await sendDiscord(
      async (url, opts) => {
        calls.push({ url, opts });
        return fakeResp(204, undefined);
      },
      "https://discord.com/api/webhooks/abc",
      { content: "hi" }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].opts.body), { content: "hi" });
  });
  it("throws on non-2xx", async () => {
    await assert.rejects(
      () =>
        sendDiscord(async () => fakeResp(404, {}), "https://x", {
          content: "hi",
        }),
      /discord 404/
    );
  });
});

describe("dispatchAlerts discord integration", () => {
  const SEARCH = {
    id: "search-1",
    user_id: "user-1",
    keywords: "ipod classic",
    max_price_cad: null,
    marketplaces: ["ebay"],
    niche: null,
    enabled: true,
  };
  const LISTING = {
    source: "ebay",
    source_id: "v1|123|0",
    title: "iPod Classic",
    price_cad: 179.99,
    url: "https://www.ebay.ca/itm/123",
    image: null,
    location: "Toronto, ON",
    posted_at: "2026-09-24T10:00:00Z",
    niche: null,
    created_at: "2026-09-24T10:05:00Z",
  };

  function dispatcherFetch(discordCalls) {
    return async (url, opts = {}) => {
      const u = String(url);
      if (u.includes("/rest/v1/dispatcher_runs") && !opts.method) {
        return fakeResp(200, [{ ran_at: "2026-09-24T09:00:00.000Z", ok: true }]);
      }
      if (u.includes("/rest/v1/saved_searches")) return fakeResp(200, [SEARCH]);
      if (u.includes("/rest/v1/listings")) return fakeResp(200, [LISTING]);
      if (u.includes("/rest/v1/alerts_sent")) {
        if (opts.method === "POST") return fakeResp(201, [{}]);
        return fakeResp(200, []);
      }
      if (u.includes("/auth/v1/admin/users/")) {
        return fakeResp(200, { email: "user@example.com" });
      }
      if (u.includes("discord.com/api/webhooks")) {
        discordCalls.push({ url: u, opts });
        return fakeResp(204, undefined);
      }
      if (u.includes("api.resend.com")) {
        return fakeResp(200, { id: "email-1" });
      }
      if (u.includes("/rest/v1/dispatcher_runs")) return fakeResp(201, [{}]);
      throw new Error(`unexpected fetch: ${u}`);
    };
  }

  beforeEach(() => {
    Object.assign(process.env, {
      RESEND_API_KEY: "re-key",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/abc",
    });
  });

  it("posts each match to Discord and reports discord_sent", async () => {
    const discordCalls = [];
    const res = await dispatchAlerts({
      fetchImpl: dispatcherFetch(discordCalls),
      loadListings: async () => [LISTING],
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.matches, 1);
    assert.equal(body.discord_sent, 1);
    assert.equal(discordCalls.length, 1);
    const payload = JSON.parse(discordCalls[0].opts.body);
    assert.ok(payload.content.includes("ipod classic"));
  });

  it("skips Discord silently when DISCORD_WEBHOOK_URL is unset", async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    const discordCalls = [];
    const res = await dispatchAlerts({
      fetchImpl: dispatcherFetch(discordCalls),
      loadListings: async () => [LISTING],
    });
    const body = JSON.parse(res.body);
    assert.equal(body.discord_sent, 0);
    assert.equal(discordCalls.length, 0);
    assert.equal(body.emails_sent, 1); // email path unaffected
  });

  it("a Discord failure is logged, not fatal", async () => {
    const badFetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes("discord.com/api/webhooks")) return fakeResp(500, {});
      return dispatcherFetch([])(url, opts);
    };
    const res = await dispatchAlerts({
      fetchImpl: badFetch,
      loadListings: async () => [LISTING],
    });
    const body = JSON.parse(res.body);
    assert.equal(body.discord_sent, 0);
    assert.equal(body.emails_sent, 1);
    assert.ok(body.errors.some((e) => e.error.startsWith("discord failed")));
  });
});
