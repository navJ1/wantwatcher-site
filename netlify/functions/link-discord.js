/**
 * Netlify Function: link-discord
 *
 * POST /.netlify/functions/link-discord
 *
 * Body (paid path):
 *   { "session_id": "<stripe checkout session id>", "discord_username": "some.user" }
 *
 * Body (free 3-day trial path — no card):
 *   { "trial": true, "discord_username": "some.user" }
 *
 * Paid flow:  Stripe session must be paid  ->  find member in the guild by
 *              username  ->  grant DISCORD_PRO_ROLE_ID.
 * Trial flow:  no Stripe check            ->  find member in the guild by
 *              username  ->  grant DISCORD_TRIAL_ROLE_ID and record the trial
 *              in Netlify Blobs with a 72h expiry (expire-trials.js revokes
 *              it later).
 *
 * Responses are always JSON:
 *   { "ok": true, "path": "paid"|"trial", "user_id": "...", "expires_at": "..." }
 *   { "ok": false, "error": "invalid_method"|"invalid_input"|"unpaid_session"
 *                            |"not_in_server"|"already_pro"|"stripe_error"
 *                            |"discord_error"|"config_error"|"store_error" }
 *
 * Env vars (set in Netlify; never hardcode):
 *   STRIPE_SECRET_KEY, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID,
 *   DISCORD_PRO_ROLE_ID, DISCORD_TRIAL_ROLE_ID
 *
 * Plain fetch/REST only — no SDKs. Node 18+ (global fetch).
 */

"use strict";

const STRIPE_API = "https://api.stripe.com/v1";
const DISCORD_API = "https://discord.com/api/v10";
const TRIAL_HOURS = 72;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function fail(code, httpStatus, detail) {
  const body = { ok: false, error: code };
  if (detail) body.detail = detail;
  return json(httpStatus, body);
}

async function readBody(event) {
  const raw = event.body || "";
  const text = event.isBase64Encoded
    ? Buffer.from(raw, "base64").toString("utf8")
    : raw;
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null; // invalid JSON
  }
}

async function stripeGetSession(stripeKey, sessionId, fetchImpl) {
  const res = await fetchImpl(
    `${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${stripeKey}:`).toString("base64"),
      },
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`stripe ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Find a guild member by their Discord username. Returns null when the
 *  user is not in the server. */
async function findGuildMember(botToken, guildId, username, fetchImpl) {
  const res = await fetchImpl(
    `${DISCORD_API}/guilds/${guildId}/members/search?query=${encodeURIComponent(
      username
    )}&limit=10`,
    { headers: { Authorization: `Bot ${botToken}` } }
  );
  if (res.status === 404) return null; // guild not found — treat as not found
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`discord search ${res.status}: ${text.slice(0, 200)}`);
  }
  const members = await res.json();
  // Prefer an exact case-insensitive username match; fall back to first hit.
  const exact = members.find(
    (m) =>
      m.user &&
      m.user.username &&
      m.user.username.toLowerCase() === username.toLowerCase()
  );
  return exact || members[0] || null;
}

async function addRole(botToken, guildId, userId, roleId, fetchImpl) {
  const res = await fetchImpl(
    `${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    { method: "PUT", headers: { Authorization: `Bot ${botToken}` } }
  );
  if (res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(`discord add-role ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function defaultTrialStore() {
  const { getStore } = await import("@netlify/blobs");
  return getStore("trials");
}

/**
 * Core handler with injectable deps so tests can run without real
 * credentials: deps = { fetchImpl, getTrialStore }.
 */
async function linkDiscord(event, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const getTrialStore = deps.getTrialStore || defaultTrialStore;

  if (event.httpMethod !== "POST") {
    return fail("invalid_method", 405, "Use POST.");
  }

  const body = await readBody(event);
  if (!body) return fail("invalid_input", 400, "Request body must be JSON.");

  const discordUsername = (body.discord_username || "").trim();
  const isTrial = body.trial === true;
  const sessionId = (body.session_id || "").trim();

  if (!discordUsername) {
    return fail("invalid_input", 400, "discord_username is required.");
  }
  if (!isTrial && !sessionId) {
    return fail(
      "invalid_input",
      400,
      "session_id is required unless trial=true."
    );
  }

  const env = process.env;
  const stripeKey = env.STRIPE_SECRET_KEY;
  const botToken = env.DISCORD_BOT_TOKEN;
  const guildId = env.DISCORD_GUILD_ID;
  const proRoleId = env.DISCORD_PRO_ROLE_ID;
  const trialRoleId = env.DISCORD_TRIAL_ROLE_ID;

  const missing = [];
  if (!botToken) missing.push("DISCORD_BOT_TOKEN");
  if (!guildId) missing.push("DISCORD_GUILD_ID");
  if (!proRoleId) missing.push("DISCORD_PRO_ROLE_ID");
  if (isTrial) {
    if (!trialRoleId) missing.push("DISCORD_TRIAL_ROLE_ID");
  } else if (!stripeKey) {
    missing.push("STRIPE_SECRET_KEY");
  }
  if (missing.length) {
    return fail(
      "config_error",
      500,
      `Server is missing environment variables: ${missing.join(", ")}`
    );
  }

  // -- paid path: verify the Stripe session before touching Discord --------
  if (!isTrial) {
    let session;
    try {
      session = await stripeGetSession(stripeKey, sessionId, fetchImpl);
    } catch (e) {
      return fail("stripe_error", 502, e.message);
    }
    if (session.payment_status !== "paid") {
      return fail(
        "unpaid_session",
        402,
        `Checkout session is "${session.payment_status}", not paid.`
      );
    }
  }

  // -- resolve the Discord user -------------------------------------------
  let member;
  try {
    member = await findGuildMember(botToken, guildId, discordUsername, fetchImpl);
  } catch (e) {
    return fail("discord_error", 502, e.message);
  }
  if (!member) {
    return fail(
      "not_in_server",
      404,
      "That username wasn't found in the server. Join the Discord server first, then try again."
    );
  }

  const roleId = isTrial ? trialRoleId : proRoleId;
  const roles = member.roles || [];

  if (roles.includes(proRoleId)) {
    return fail("already_pro", 409, "This account already has Pro access.");
  }
  if (isTrial && roles.includes(trialRoleId)) {
    return fail(
      "already_pro",
      409,
      "This account already has an active trial."
    );
  }

  // -- grant the role -------------------------------------------------------
  try {
    await addRole(botToken, guildId, member.user.id, roleId, fetchImpl);
  } catch (e) {
    return fail("discord_error", 502, e.message);
  }

  const result = {
    ok: true,
    path: isTrial ? "trial" : "paid",
    user_id: member.user.id,
  };

  // -- trial path: record expiry in Blobs ----------------------------------
  if (isTrial) {
    const expiresAt = new Date(Date.now() + TRIAL_HOURS * 3600 * 1000);
    try {
      const store = await getTrialStore();
      await store.setJSON(`trial-${member.user.id}`, {
        user_id: member.user.id,
        discord_username: member.user.username,
        expires_at: expiresAt.toISOString(),
        created_at: new Date().toISOString(),
      });
    } catch (e) {
      return fail("store_error", 500, `Trial role granted but not recorded: ${e.message}`);
    }
    result.expires_at = expiresAt.toISOString();
  }

  return json(200, result);
}

exports.handler = async (event, context) => linkDiscord(event, {});
exports.linkDiscord = linkDiscord; // exported for the test suite
