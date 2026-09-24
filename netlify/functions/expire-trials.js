/**
 * Netlify Function: expire-trials (scheduled, every 24h)
 *
 * Reads trial records from Netlify Blobs ("trials" store, keys "trial-<user_id>").
 * For every record whose expires_at is in the past:
 *   1. removes the DISCORD_TRIAL_ROLE_ID from the member via Discord REST
 *      (DELETE .../guilds/{guild}/members/{user}/roles/{role} -> 204),
 *   2. deletes the record so it is not processed again.
 *
 * Returns JSON: { ok: true, checked: N, expired: M, errors: [...] }
 *
 * Env vars: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_TRIAL_ROLE_ID.
 * Plain fetch/REST only — no SDKs. Node 18+ (global fetch).
 */

"use strict";

const DISCORD_API = "https://discord.com/api/v10";

async function defaultTrialStore() {
  const { getStore } = await import("@netlify/blobs");
  return getStore("trials");
}

async function removeRole(botToken, guildId, userId, roleId, fetchImpl) {
  const res = await fetchImpl(
    `${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    { method: "DELETE", headers: { Authorization: `Bot ${botToken}` } }
  );
  // 204 = removed. 404 = member or role already gone — nothing left to do.
  if (res.status === 204 || res.status === 404) return;
  const text = await res.text().catch(() => "");
  throw new Error(`discord remove-role ${res.status}: ${text.slice(0, 200)}`);
}

/**
 * Core logic with injectable deps for tests:
 * deps = { fetchImpl, getTrialStore, now }.
 */
async function expireTrials(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const getTrialStore = deps.getTrialStore || defaultTrialStore;
  const now = deps.now || new Date();

  const { DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_TRIAL_ROLE_ID } =
    process.env;
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID || !DISCORD_TRIAL_ROLE_ID) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: "config_error",
        detail:
          "Missing DISCORD_BOT_TOKEN / DISCORD_GUILD_ID / DISCORD_TRIAL_ROLE_ID",
      }),
    };
  }

  const store = await getTrialStore();
  const listing = await store.list({ prefix: "trial-" });
  const keys = (listing.blobs || []).map((b) => b.key);

  const errors = [];
  let expired = 0;

  for (const key of keys) {
    let record;
    try {
      record = await store.get(key, { type: "json" });
    } catch (e) {
      errors.push({ key, error: `read failed: ${e.message}` });
      continue;
    }
    if (!record || !record.user_id || !record.expires_at) {
      errors.push({ key, error: "malformed record; deleting" });
      await store.delete(key).catch(() => {});
      continue;
    }
    if (new Date(record.expires_at) > now) continue; // still active

    try {
      await removeRole(
        DISCORD_BOT_TOKEN,
        DISCORD_GUILD_ID,
        record.user_id,
        DISCORD_TRIAL_ROLE_ID,
        fetchImpl
      );
      await store.delete(key);
      expired++;
    } catch (e) {
      errors.push({ key, user_id: record.user_id, error: e.message });
      // record is left in place so a later run can retry
    }
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ok: true,
      checked: keys.length,
      expired,
      errors,
    }),
  };
}

// Netlify scheduled function entry point (triggered by netlify.toml schedule).
exports.handler = async (event, context) => expireTrials({});
exports.expireTrials = expireTrials; // exported for the test suite
