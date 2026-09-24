/**
 * Unit tests for the Netlify Functions (link-discord, expire-trials).
 *
 * No network, no real credentials: fetch and the Blobs store are injected.
 * Run: node --test netlify/functions/test_functions.js
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { linkDiscord } = require("../netlify/functions/link-discord.js");
const { expireTrials } = require("../netlify/functions/expire-trials.js");

// ---------------------------------------------------------------- helpers

function fakeResp(status, jsonBody) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => jsonBody,
    text: async () => (jsonBody === undefined ? "" : JSON.stringify(jsonBody)),
  };
}

/** In-memory Blobs stand-in. failOn: { list, get, setJSON, delete } -> Error message.
 *  pageSize > 0 splits the listing into pages of that size when paginate:true,
 *  emulating @netlify/blobs' paginated async iterator. */
function makeStore(records = {}, failOn = {}, pageSize = 0) {
  const calls = { setJSON: [], deleted: [] };
  const store = {
    calls,
    async list(opts = {}) {
      if (failOn.list) throw new Error(failOn.list);
      const blobs = Object.keys(records).map((k) => ({ key: k }));
      if (opts.paginate) {
        const pages = [];
        const size = pageSize > 0 ? pageSize : Math.max(blobs.length, 1);
        for (let i = 0; i < blobs.length; i += size) {
          pages.push({ blobs: blobs.slice(i, i + size) });
        }
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const page of pages) yield page;
          },
        };
      }
      return { blobs };
    },
    async get(key) {
      if (failOn.get) throw new Error(failOn.get);
      return key in records ? records[key] : null;
    },
    async setJSON(key, val) {
      if (failOn.setJSON) throw new Error(failOn.setJSON);
      calls.setJSON.push([key, val]);
      records[key] = val;
    },
    async delete(key) {
      if (failOn.delete) throw new Error(failOn.delete);
      calls.deleted.push(key);
      delete records[key];
    },
  };
  return store;
}

function trialEvent(extra = {}) {
  return {
    httpMethod: "POST",
    body: JSON.stringify(
      Object.assign({ trial: true, discord_username: "Some.User" }, extra)
    ),
  };
}

const TRIAL_ENV = {
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_GUILD_ID: "guild-1",
  DISCORD_PRO_ROLE_ID: "role-pro",
  DISCORD_TRIAL_ROLE_ID: "role-trial",
};

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  process.env = savedEnv;
});

function setEnv(vars) {
  for (const k of Object.keys(TRIAL_ENV)) delete process.env[k];
  delete process.env.STRIPE_SECRET_KEY;
  Object.assign(process.env, vars);
}

function bodyOf(res) {
  assert.equal(res.headers["content-type"], "application/json");
  return JSON.parse(res.body);
}

/** Fetch stub routing by URL/method. Throws on unexpected calls. */
function makeDiscordFetch({ member = null, putStatus = 204, deleteStatus = 204 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ url, method });
    if (url.includes("/members/search")) {
      return fakeResp(200, member ? [member] : []);
    }
    if (url.includes("/roles/") && method === "PUT") {
      return fakeResp(putStatus, undefined);
    }
    if (url.includes("/roles/") && method === "DELETE") {
      return fakeResp(deleteStatus, undefined);
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

const MEMBER = { user: { id: "u1", username: "Some.User" }, roles: [] };

// ------------------------------------------------------------- link-discord

describe("link-discord", () => {
  it("trial: missing env -> 500 config_error, no external calls", async () => {
    setEnv({});
    let called = false;
    const fetchImpl = async () => {
      called = true;
      throw new Error("must not be called");
    };
    const res = await linkDiscord(trialEvent(), {
      fetchImpl,
      getTrialStore: async () => {
        throw new Error("must not be called");
      },
    });
    assert.equal(res.statusCode, 500);
    const b = bodyOf(res);
    assert.equal(b.ok, false);
    assert.equal(b.error, "config_error");
    assert.match(b.detail, /DISCORD_BOT_TOKEN/);
    assert.equal(called, false);
  });

  it("trial: partially missing env names every missing var", async () => {
    setEnv({ DISCORD_BOT_TOKEN: "x" });
    const res = await linkDiscord(trialEvent(), {});
    const b = bodyOf(res);
    assert.equal(res.statusCode, 500);
    assert.equal(b.error, "config_error");
    assert.match(b.detail, /DISCORD_GUILD_ID/);
    assert.match(b.detail, /DISCORD_TRIAL_ROLE_ID/);
    assert.doesNotMatch(b.detail, /DISCORD_BOT_TOKEN/);
  });

  it("paid: missing STRIPE_SECRET_KEY -> 500 config_error", async () => {
    setEnv(TRIAL_ENV);
    const res = await linkDiscord(
      {
        httpMethod: "POST",
        body: JSON.stringify({
          session_id: "cs_123",
          discord_username: "Some.User",
        }),
      },
      {}
    );
    const b = bodyOf(res);
    assert.equal(res.statusCode, 500);
    assert.equal(b.error, "config_error");
    assert.match(b.detail, /STRIPE_SECRET_KEY/);
  });

  it("rejects non-POST with 405", async () => {
    setEnv(TRIAL_ENV);
    const res = await linkDiscord({ httpMethod: "GET" }, {});
    assert.equal(res.statusCode, 405);
    assert.equal(bodyOf(res).error, "invalid_method");
  });

  it("rejects invalid JSON with 400", async () => {
    setEnv(TRIAL_ENV);
    const res = await linkDiscord(
      { httpMethod: "POST", body: "{nope" },
      {}
    );
    assert.equal(res.statusCode, 400);
    assert.equal(bodyOf(res).error, "invalid_input");
  });

  it("rejects missing discord_username with 400", async () => {
    setEnv(TRIAL_ENV);
    const res = await linkDiscord(trialEvent({ discord_username: " " }), {});
    assert.equal(res.statusCode, 400);
    assert.equal(bodyOf(res).error, "invalid_input");
  });

  it("trial: happy path grants role and records expiry", async () => {
    setEnv(TRIAL_ENV);
    const { fetchImpl, calls } = makeDiscordFetch({ member: MEMBER });
    const store = makeStore();
    const res = await linkDiscord(trialEvent(), {
      fetchImpl,
      getTrialStore: async () => store,
    });
    assert.equal(res.statusCode, 200);
    const b = bodyOf(res);
    assert.deepEqual(
      { ok: b.ok, path: b.path, user_id: b.user_id },
      { ok: true, path: "trial", user_id: "u1" }
    );
    assert.ok(b.expires_at, "expires_at present");
    assert.equal(store.calls.setJSON.length, 1);
    assert.equal(store.calls.setJSON[0][0], "trial-u1");
    assert.ok(calls.some((c) => c.method === "PUT"), "role granted via PUT");
  });

  it("trial: store failure rolls back the granted role", async () => {
    setEnv(TRIAL_ENV);
    const { fetchImpl, calls } = makeDiscordFetch({ member: MEMBER });
    const store = makeStore({}, { setJSON: "blobs down" });
    const res = await linkDiscord(trialEvent(), {
      fetchImpl,
      getTrialStore: async () => store,
    });
    assert.equal(res.statusCode, 500);
    const b = bodyOf(res);
    assert.equal(b.error, "store_error");
    assert.match(b.detail, /removed/i);
    assert.ok(
      calls.some((c) => c.method === "DELETE"),
      "rollback DELETE was attempted"
    );
  });

  it("trial: store failure + rollback failure says manual fix needed", async () => {
    setEnv(TRIAL_ENV);
    const { fetchImpl } = makeDiscordFetch({
      member: MEMBER,
      deleteStatus: 500,
    });
    const store = makeStore({}, { setJSON: "blobs down" });
    const res = await linkDiscord(trialEvent(), {
      fetchImpl,
      getTrialStore: async () => store,
    });
    assert.equal(res.statusCode, 500);
    const b = bodyOf(res);
    assert.equal(b.error, "store_error");
    assert.match(b.detail, /manual/i);
  });

  it("trial: malformed member shape -> 502, no crash", async () => {
    setEnv(TRIAL_ENV);
    const { fetchImpl } = makeDiscordFetch({ member: { roles: [] } });
    const store = makeStore();
    const res = await linkDiscord(trialEvent(), {
      fetchImpl,
      getTrialStore: async () => store,
    });
    assert.equal(res.statusCode, 502);
    assert.equal(bodyOf(res).error, "discord_error");
    assert.equal(store.calls.setJSON.length, 0);
  });

  it("trial: user not in server -> 404, role never granted", async () => {
    setEnv(TRIAL_ENV);
    const { fetchImpl, calls } = makeDiscordFetch({ member: null });
    const store = makeStore();
    const res = await linkDiscord(trialEvent(), {
      fetchImpl,
      getTrialStore: async () => store,
    });
    assert.equal(res.statusCode, 404);
    assert.equal(bodyOf(res).error, "not_in_server");
    assert.ok(!calls.some((c) => c.method === "PUT"), "no PUT happened");
  });

  it("trial: already-on-trial user -> 409", async () => {
    setEnv(TRIAL_ENV);
    const { fetchImpl } = makeDiscordFetch({
      member: { user: { id: "u1", username: "Some.User" }, roles: ["role-trial"] },
    });
    const res = await linkDiscord(trialEvent(), {
      fetchImpl,
      getTrialStore: async () => makeStore(),
    });
    assert.equal(res.statusCode, 409);
    assert.equal(bodyOf(res).error, "already_pro");
  });

  it("paid: unpaid session -> 402, Discord never touched", async () => {
    setEnv({ ...TRIAL_ENV, STRIPE_SECRET_KEY: "sk_test" });
    const discordCalls = [];
    const fetchImpl = async (url, opts = {}) => {
      if (url.includes("api.stripe.com")) {
        return fakeResp(200, { payment_status: "unpaid" });
      }
      discordCalls.push(url);
      throw new Error("discord must not be called");
    };
    const res = await linkDiscord(
      {
        httpMethod: "POST",
        body: JSON.stringify({
          session_id: "cs_123",
          discord_username: "Some.User",
        }),
      },
      { fetchImpl }
    );
    assert.equal(res.statusCode, 402);
    assert.equal(bodyOf(res).error, "unpaid_session");
    assert.equal(discordCalls.length, 0);
  });

  it("paid: stripe error -> 502 stripe_error", async () => {
    setEnv({ ...TRIAL_ENV, STRIPE_SECRET_KEY: "sk_test" });
    const fetchImpl = async () => fakeResp(401, { error: "bad key" });
    const res = await linkDiscord(
      {
        httpMethod: "POST",
        body: JSON.stringify({
          session_id: "cs_123",
          discord_username: "Some.User",
        }),
      },
      { fetchImpl }
    );
    assert.equal(res.statusCode, 502);
    assert.equal(bodyOf(res).error, "stripe_error");
  });
});

// ------------------------------------------------------------ expire-trials

describe("expire-trials", () => {
  const NOW = new Date("2026-09-24T12:00:00Z");

  it("missing env -> 500 config_error, store untouched", async () => {
    setEnv({});
    let storeTouched = false;
    const res = await expireTrials({
      now: NOW,
      getTrialStore: async () => {
        storeTouched = true;
        throw new Error("must not be called");
      },
    });
    assert.equal(res.statusCode, 500);
    const b = bodyOf(res);
    assert.equal(b.error, "config_error");
    assert.equal(storeTouched, false);
  });

  it("blobs outage -> 500 store_error JSON, no crash", async () => {
    setEnv(TRIAL_ENV);
    const res = await expireTrials({
      now: NOW,
      getTrialStore: async () => {
        throw new Error("blobs down");
      },
    });
    assert.equal(res.statusCode, 500);
    const b = bodyOf(res);
    assert.equal(b.error, "store_error");
    assert.match(b.detail, /unavailable/);
  });

  it("expired trial: role removed and record deleted", async () => {
    setEnv(TRIAL_ENV);
    const fetchCalls = [];
    const fetchImpl = async (url, opts = {}) => {
      fetchCalls.push({ url, method: opts.method });
      return fakeResp(204, undefined);
    };
    const store = makeStore({
      "trial-u1": {
        user_id: "u1",
        expires_at: "2026-09-20T00:00:00Z",
      },
    });
    const res = await expireTrials({
      now: NOW,
      fetchImpl,
      getTrialStore: async () => store,
    });
    assert.equal(res.statusCode, 200);
    const b = bodyOf(res);
    assert.deepEqual(
      { ok: b.ok, checked: b.checked, expired: b.expired, errors: b.errors },
      { ok: true, checked: 1, expired: 1, errors: [] }
    );
    assert.ok(fetchCalls.some((c) => c.method === "DELETE"));
    assert.deepEqual(store.calls.deleted, ["trial-u1"]);
  });

  it("active trial: left alone", async () => {
    setEnv(TRIAL_ENV);
    let fetched = false;
    const store = makeStore({
      "trial-u2": {
        user_id: "u2",
        expires_at: "2026-09-30T00:00:00Z",
      },
    });
    const res = await expireTrials({
      now: NOW,
      fetchImpl: async () => {
        fetched = true;
        return fakeResp(204, undefined);
      },
      getTrialStore: async () => store,
    });
    const b = bodyOf(res);
    assert.equal(b.expired, 0);
    assert.equal(fetched, false);
    assert.deepEqual(store.calls.deleted, []);
  });

  it("removeRole 404 (already gone) still deletes the record", async () => {
    setEnv(TRIAL_ENV);
    const fetchImpl = async () => fakeResp(404, undefined);
    const store = makeStore({
      "trial-u3": { user_id: "u3", expires_at: "2026-09-20T00:00:00Z" },
    });
    const res = await expireTrials({
      now: NOW,
      fetchImpl,
      getTrialStore: async () => store,
    });
    const b = bodyOf(res);
    assert.equal(b.expired, 1);
    assert.deepEqual(store.calls.deleted, ["trial-u3"]);
  });

  it("removeRole failure: error logged, record kept for retry", async () => {
    setEnv(TRIAL_ENV);
    const fetchImpl = async () => fakeResp(500, { message: "boom" });
    const store = makeStore({
      "trial-u4": { user_id: "u4", expires_at: "2026-09-20T00:00:00Z" },
    });
    const res = await expireTrials({
      now: NOW,
      fetchImpl,
      getTrialStore: async () => store,
    });
    const b = bodyOf(res);
    assert.equal(b.expired, 0);
    assert.equal(b.errors.length, 1);
    assert.equal(b.errors[0].user_id, "u4");
    assert.deepEqual(store.calls.deleted, [], "record kept so a later run retries");
  });

  it("malformed record: deleted and reported", async () => {
    setEnv(TRIAL_ENV);
    const store = makeStore({ "trial-bad": { nope: true } });
    const res = await expireTrials({
      now: NOW,
      fetchImpl: async () => fakeResp(204, undefined),
      getTrialStore: async () => store,
    });
    const b = bodyOf(res);
    assert.equal(b.checked, 1);
    assert.equal(b.expired, 0);
    assert.equal(b.errors.length, 1);
    assert.match(b.errors[0].error, /malformed/);
    assert.deepEqual(store.calls.deleted, ["trial-bad"]);
  });

  it("paginated listing: trials beyond the first page are processed", async () => {
    setEnv(TRIAL_ENV);
    const fetchCalls = [];
    const fetchImpl = async (url, opts = {}) => {
      fetchCalls.push({ url, method: opts.method });
      return fakeResp(204, undefined);
    };
    const store = makeStore(
      {
        "trial-p1": { user_id: "p1", expires_at: "2026-09-20T00:00:00Z" },
        "trial-p2": { user_id: "p2", expires_at: "2026-09-30T00:00:00Z" }, // active
        "trial-p3": { user_id: "p3", expires_at: "2026-09-21T00:00:00Z" },
      },
      {},
      1 // one key per page: without pagination p2/p3 would be invisible
    );
    const res = await expireTrials({
      now: NOW,
      fetchImpl,
      getTrialStore: async () => store,
    });
    const b = bodyOf(res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      { ok: b.ok, checked: b.checked, expired: b.expired, errors: b.errors },
      { ok: true, checked: 3, expired: 2, errors: [] }
    );
    assert.deepEqual(store.calls.deleted.sort(), ["trial-p1", "trial-p3"]);
  });

  it("invalid expires_at: deleted and reported, Discord role untouched", async () => {
    setEnv(TRIAL_ENV);
    let fetched = false;
    const store = makeStore({
      "trial-x1": { user_id: "x1", expires_at: "not-a-date" },
    });
    const res = await expireTrials({
      now: NOW,
      fetchImpl: async () => {
        fetched = true;
        return fakeResp(204, undefined);
      },
      getTrialStore: async () => store,
    });
    const b = bodyOf(res);
    assert.equal(b.checked, 1);
    assert.equal(b.expired, 0);
    assert.equal(b.errors.length, 1);
    assert.match(b.errors[0].error, /invalid expires_at/);
    assert.equal(
      fetched,
      false,
      "unparseable expiry must not trigger a role removal"
    );
    assert.deepEqual(store.calls.deleted, ["trial-x1"]);
  });

  it("invalid expires_at with failing delete: reported, left for next run", async () => {
    setEnv(TRIAL_ENV);
    const store = makeStore(
      { "trial-x2": { user_id: "x2", expires_at: "not-a-date" } },
      { delete: "blobs down" }
    );
    const res = await expireTrials({
      now: NOW,
      fetchImpl: async () => fakeResp(204, undefined),
      getTrialStore: async () => store,
    });
    const b = bodyOf(res);
    assert.equal(b.checked, 1);
    assert.equal(b.expired, 0);
    assert.equal(b.errors.length, 1);
    assert.match(b.errors[0].error, /invalid expires_at; delete failed/);
    assert.deepEqual(store.calls.deleted, []);
  });
});
