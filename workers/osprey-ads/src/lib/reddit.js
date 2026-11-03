/* =========================================================================
   Reddit Data API client
   - OAuth 2.0 "web app" flow, duration=permanent, minimum scopes.
   - Every authenticated call goes to https://oauth.reddit.com.
   - X-Ratelimit-Remaining / -Used / -Reset are recorded after every call
     (in D1, shared by the API, watcher and submitter Workers) and checked
     before the next one, so Reddit calls stay paced instead of bursty.
   ========================================================================= */
import { encrypt, decrypt } from "./crypto.js";
import { now, HttpError } from "./util.js";

export const SCOPES = ["identity", "read", "submit"]; // identity: show which account is connected
const AUTH_URL = "https://www.reddit.com/api/v1/authorize";
const RESERVE = 5; // keep a few requests in hand for the submitter

export class RateLimitError extends Error {
  constructor(resetAt) { super("Reddit rate limit reached"); this.resetAt = resetAt; }
  get delaySeconds() { return Math.max(5, Math.ceil((this.resetAt - now()) / 1000) + 2); }
}

const apiBase = (env) => env.REDDIT_API_BASE || "https://oauth.reddit.com";
const tokenUrl = (env) => env.REDDIT_TOKEN_URL || "https://www.reddit.com/api/v1/access_token";
export const redirectUri = (env) => env.REDDIT_REDIRECT_URI || `${env.API_ORIGIN}/api/reddit/callback`;

/** Reddit asks for <platform>:<app id>:<version> (by /u/<username>) and no masking. */
export const userAgent = (env) =>
  `web:build.osprey.ads:v1.0 (by /u/${env.REDDIT_USERNAME || "unknown"})`;

/**
 * Fill in the Reddit app credentials saved from the dashboard (D1 reddit_app) when the
 * Worker has no REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET secrets. Returns a new env object.
 */
export async function withRedditApp(env) {
  if (!env.DB || (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USERNAME)) return env;
  let row = null;
  try { row = await env.DB.prepare("SELECT client_id, client_secret_enc, username FROM reddit_app WHERE id = 1").first(); } catch { return env; }
  if (!row) return env;
  const out = Object.assign(Object.create(Object.getPrototypeOf(env)), env);
  if (!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) && env.TOKEN_ENC_KEY) {
    try { out.REDDIT_CLIENT_ID = row.client_id; out.REDDIT_CLIENT_SECRET = await decrypt(env, row.client_secret_enc); } catch { /* wrong key: stay unconfigured */ }
  }
  if (!env.REDDIT_USERNAME && row.username) out.REDDIT_USERNAME = row.username;
  if (!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET)) out.REDDIT_APP_SOURCE = "dashboard";
  return out;
}

export async function saveRedditApp(env, db, { client_id, client_secret, username }, adminId) {
  if (!env.TOKEN_ENC_KEY) throw new HttpError(500, "TOKEN_ENC_KEY isn't set on the Worker.");
  const id = String(client_id || "").trim(), secret = String(client_secret || "").trim();
  const user = String(username || "").trim().replace(/^\/?u\//i, "");
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) throw new HttpError(400, "That doesn't look like a Reddit client ID (the string under the app name).");
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(secret)) throw new HttpError(400, "That doesn't look like a Reddit client secret.");
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(user)) throw new HttpError(400, "Enter the Reddit username that owns the app, without u/.");
  await db.prepare(`INSERT INTO reddit_app (id, client_id, client_secret_enc, username, updated_by, updated_at) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id, client_secret_enc=excluded.client_secret_enc,
        username=excluded.username, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .bind(id, await encrypt(env, secret), user, adminId, now()).run();
  return { client_id: id, username: user };
}

export async function redditAppInfo(env, db) {
  const row = await db.prepare("SELECT client_id, username, updated_at FROM reddit_app WHERE id = 1").first().catch(() => null);
  const fromSecrets = Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET);
  return { source: env.REDDIT_APP_SOURCE || (fromSecrets ? "worker" : row ? "dashboard" : null),
    client_id_hint: (fromSecrets ? env.REDDIT_CLIENT_ID : row?.client_id || "").slice(0, 4) || null,
    username: env.REDDIT_USERNAME || row?.username || null, updated_at: row?.updated_at || null,
    redirect_uri: redirectUri(env) };
}

export function isConfigured(env) {
  return Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.TOKEN_ENC_KEY);
}

export function authorizeUrl(env, state) {
  const q = new URLSearchParams({
    client_id: env.REDDIT_CLIENT_ID, response_type: "code", state,
    redirect_uri: redirectUri(env), duration: "permanent", scope: SCOPES.join(" "),
  });
  return `${env.REDDIT_AUTH_URL || AUTH_URL}?${q}`;
}

async function tokenRequest(env, form) {
  const res = await fetch(tokenUrl(env), {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent(env),
    },
    body: new URLSearchParams(form),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) throw new Error(`Reddit token error: ${data.error || res.status}`);
  return data;
}

export async function exchangeCode(env, db, code, adminId) {
  const t = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(env) });
  if (!t.refresh_token) throw new Error("Reddit didn't return a refresh token");
  await db.prepare(`INSERT INTO reddit_accounts (id, username, scopes, refresh_token_enc, access_token_enc, access_expires_at, connected_by, connected_at)
      VALUES (1, NULL, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET scopes=excluded.scopes, refresh_token_enc=excluded.refresh_token_enc,
        access_token_enc=excluded.access_token_enc, access_expires_at=excluded.access_expires_at,
        connected_by=excluded.connected_by, connected_at=excluded.connected_at, username=NULL`)
    .bind(t.scope || SCOPES.join(" "), await encrypt(env, t.refresh_token), await encrypt(env, t.access_token),
      now() + (Number(t.expires_in) || 3600) * 1000, adminId, now()).run();
  const me = await call(env, db, "GET", "/api/v1/me");
  await db.prepare("UPDATE reddit_accounts SET username = ? WHERE id = 1").bind(me.name || null).run();
  return me.name;
}

async function accessToken(env, db, force = false) {
  const acct = await db.prepare("SELECT * FROM reddit_accounts WHERE id = 1").first();
  if (!acct) throw new HttpError(409, "Reddit isn't connected.");
  if (!force && acct.access_token_enc && acct.access_expires_at > now() + 60_000) return decrypt(env, acct.access_token_enc);
  const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: await decrypt(env, acct.refresh_token_enc) });
  await db.prepare("UPDATE reddit_accounts SET access_token_enc = ?, access_expires_at = ? WHERE id = 1")
    .bind(await encrypt(env, t.access_token), now() + (Number(t.expires_in) || 3600) * 1000).run();
  return t.access_token;
}

export async function getRateState(db) {
  return (await db.prepare("SELECT remaining, used, reset_at, updated_at FROM rate_state WHERE id = 1").first()) || {};
}

/** Throws RateLimitError if the last known window is nearly spent and hasn't reset yet. */
export async function assertRateBudget(db, reserve = RESERVE) {
  const r = await getRateState(db);
  if (r.remaining != null && r.reset_at && r.reset_at > now() && r.remaining <= reserve) throw new RateLimitError(r.reset_at);
}

async function recordRate(db, res) {
  const rem = res.headers.get("x-ratelimit-remaining");
  const used = res.headers.get("x-ratelimit-used");
  const reset = res.headers.get("x-ratelimit-reset");
  if (rem == null && reset == null) return null;
  const state = { remaining: rem == null ? null : Number(rem), used: used == null ? null : Number(used),
    reset_at: reset == null ? null : now() + Number(reset) * 1000 };
  await db.prepare("UPDATE rate_state SET remaining = ?, used = ?, reset_at = ?, updated_at = ? WHERE id = 1")
    .bind(state.remaining, state.used, state.reset_at, now()).run();
  return state;
}

/**
 * Authenticated call to oauth.reddit.com.
 * opts.reserve: how many requests must remain in the window (watcher uses a larger reserve than the submitter).
 */
export async function call(env, db, method, path, form, opts = {}) {
  await assertRateBudget(db, opts.reserve ?? 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(env, db, attempt > 0);
    const url = apiBase(env) + path + (path.includes("?") ? "&" : "?") + "raw_json=1";
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent(env),
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form) : undefined,
    });
    const rate = await recordRate(db, res);
    if (res.status === 401 && attempt === 0) continue;           // token expired early: refresh once
    if (res.status === 429) throw new RateLimitError(rate?.reset_at || now() + 60_000);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const e = new Error(`Reddit returned HTTP ${res.status}`);
      e.status = res.status; e.data = data; throw e;
    }
    return data;
  }
}

/** Submit a post or comment from a payload built by buildPayload(). */
export async function sendPayload(env, db, p) {
  let form;
  if (p.endpoint === "/api/comment") form = { api_type: "json", thing_id: p.thing_id, text: p.text };
  else {
    form = { api_type: "json", sr: p.sr, kind: p.kind, title: p.title, sendreplies: "true", resubmit: "false" };
    if (p.kind === "self") form.text = p.text; else form.url = p.url;
    if (p.flair_id) form.flair_id = p.flair_id;
    if (p.flair_text) form.flair_text = p.flair_text;
  }
  const data = await call(env, db, "POST", p.endpoint, form, { reserve: 0 });
  const j = data?.json || {};
  if (j.errors && j.errors.length) {
    const msg = j.errors.map((e) => e.join(": ")).join("; ");
    const ratelimited = j.errors.some((e) => e[0] === "RATELIMIT");
    const err = new Error(`Reddit rejected the submission: ${msg}`); err.redditErrors = j.errors; err.ratelimited = ratelimited;
    throw err;
  }
  if (p.endpoint === "/api/comment") {
    const thing = j.data?.things?.[0]?.data || {};
    return { fullname: thing.name || (thing.id ? "t1_" + thing.id : null),
      permalink: thing.permalink ? "https://www.reddit.com" + thing.permalink : null };
  }
  return { fullname: j.data?.name || null, permalink: j.data?.url || null };
}

export async function listNew(env, db, subreddit, limit = 50) {
  const data = await call(env, db, "GET", `/r/${encodeURIComponent(subreddit)}/new?limit=${limit}`, null, { reserve: 20 });
  return (data?.data?.children || []).map((c) => c.data);
}

export async function getThread(env, db, fullname) {
  const data = await call(env, db, "GET", `/api/info?id=${encodeURIComponent(fullname)}`, null, { reserve: 10 });
  return data?.data?.children?.[0]?.data || null;
}
