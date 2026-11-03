/* =========================================================================
   osprey-ads-api — admin API for osprey.build/ads
   Every route except /api/health, /api/setup, /api/login and the Reddit
   OAuth callback requires an admin session (Authorization: Bearer …).
   ========================================================================= */
import { normalizeContent, contentHash, textFingerprint, normSub, parseThreadRef, buildPayload, fillTemplate } from "../../../ads/assets/content.js";
import { now, DAY, HttpError, randomId, getSettings, audit, loadDraft, parseJSON } from "./lib/util.js";
import { login, logout, requireAdmin, createAdmin } from "./lib/auth.js";
import { evaluate } from "./lib/policy.js";
import { verifyApproval } from "./lib/submit.js";
import { scanWatcher, suggestDraft, DEFAULT_KEYWORDS } from "./lib/watch.js";
import * as reddit from "./lib/reddit.js";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

function cors(env, request) {
  const allowed = String(env.ALLOWED_ORIGINS || "https://osprey.build").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin");
  if (!origin || !allowed.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Max-Age": "600", Vary: "Origin" };
}

async function body(request) {
  try { return await request.json(); } catch { throw new HttpError(400, "Request body must be JSON."); }
}
const bool = (v) => (v === true || v === 1 || v === "1" || v === "on" || v === "true" ? 1 : 0);
const int = (v, d, min = 0, max = 1e6) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const actorOf = (a) => `admin:${a.username}`;

/* ---------------- drafts ---------------- */
async function hydrateDraft(input, existing = {}) {
  const kind = input.kind ?? existing.kind;
  const subreddit = normSub(input.subreddit ?? existing.subreddit);
  const d = {
    kind, subreddit,
    thread_fullname: kind === "reply" ? (input.thread_fullname ?? existing.thread_fullname ?? null) : null,
    thread_title: kind === "reply" ? (input.thread_title ?? existing.thread_title ?? null) : null,
    thread_permalink: kind === "reply" ? (input.thread_permalink ?? existing.thread_permalink ?? null) : null,
    content: normalizeContent(input.content ?? existing.content ?? {}),
  };
  if (kind === "reply") d.content.title = "";
  d.content_hash = await contentHash(d);
  d.text_fingerprint = await textFingerprint(d);
  return d;
}

async function draftView(env, db, row, settings, connected) {
  const d = row.content ? row : { ...row, content: parseJSON(row.content_json, {}) };
  const policy = await evaluate(db, d, { settings, phase: "review", mode: settings.submit_mode, redditConnected: connected });
  const approval = await db.prepare("SELECT id, status, mode, approved_at, expires_at, content_hash, status_reason FROM approvals WHERE draft_id = ? ORDER BY approved_at DESC LIMIT 1").bind(d.id).first();
  const { content_json, ...rest } = d;
  return { ...rest, payload: buildPayload(d), blocks: policy.blocks, waits: policy.waits, rule: policy.rule, approval };
}

/* ---------------- router ---------------- */
const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), handler, ...opts });

route("GET", "/api/health", async () => json({ ok: true }), { public: true });

// First-run: create the first admin. Needs the ADMIN_SETUP_TOKEN secret and only works while no admin exists.
route("POST", "/api/setup", async ({ env, request }) => {
  const b = await body(request);
  if (!env.ADMIN_SETUP_TOKEN || b.setup_token !== env.ADMIN_SETUP_TOKEN) throw new HttpError(403, "Setup token is wrong or not configured.");
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_users").first();
  if (n.n > 0) throw new HttpError(409, "An admin already exists. Sign in instead.");
  await createAdmin(env.DB, b.username, b.password);
  await audit(env.DB, "system", "admin.created", "admin_user", b.username, { via: "setup" });
  return json({ ok: true });
}, { public: true });

route("POST", "/api/login", async ({ env, request }) => {
  const b = await body(request);
  const r = await login(env.DB, String(b.username || ""), String(b.password || ""));
  await audit(env.DB, `admin:${r.admin.username}`, "admin.login", "admin_user", r.admin.id);
  return json(r);
}, { public: true });

route("POST", "/api/logout", async ({ env, admin }) => { await logout(env.DB, admin.tokenHash); return json({ ok: true }); });
route("GET", "/api/me", async ({ admin }) => json({ admin: { id: admin.id, username: admin.username } }));

route("POST", "/api/admins", async ({ env, request, admin }) => {
  const b = await body(request);
  await createAdmin(env.DB, b.username, b.password);
  await audit(env.DB, actorOf(admin), "admin.created", "admin_user", b.username);
  return json({ ok: true });
});

/* ---- dashboard ---- */
route("GET", "/api/dashboard", async ({ env }) => {
  const db = env.DB, t = now();
  const settings = await getSettings(db);
  const acct = await db.prepare("SELECT username, scopes, connected_at FROM reddit_accounts WHERE id = 1").first();
  const counts = Object.fromEntries((await db.prepare("SELECT status, COUNT(*) AS n FROM drafts GROUP BY status").all()).results.map((r) => [r.status, r.n]));
  const opportunities = (await db.prepare("SELECT * FROM candidate_opportunities WHERE status = 'new' ORDER BY created_at DESC LIMIT 12").all()).results;
  const failures = (await db.prepare(`SELECT s.*, d.content_json FROM submissions s JOIN drafts d ON d.id = s.draft_id
      WHERE s.status IN ('failed','blocked') ORDER BY s.created_at DESC LIMIT 8`).all()).results;
  const rules = (await db.prepare("SELECT * FROM subreddit_rules ORDER BY subreddit").all()).results;
  const cooldowns = [];
  for (const r of rules) {
    const last = await db.prepare("SELECT MAX(created_at) AS at FROM submissions WHERE subreddit = ? AND status = 'submitted'").bind(r.subreddit).first();
    const today = await db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE subreddit = ? AND status = 'submitted' AND created_at > ?").bind(r.subreddit, t - DAY).first();
    cooldowns.push({ subreddit: r.subreddit, blacklisted: r.blacklisted, paused: r.paused, cooldown_hours: r.cooldown_hours, max_per_day: r.max_per_day,
      last_submitted_at: last?.at || null, next_allowed_at: last?.at ? last.at + r.cooldown_hours * 3600_000 : null, last_24h: today.n });
  }
  const used = await db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'submitted' AND created_at > ?").bind(t - DAY).first();
  const watchers = (await db.prepare("SELECT id, subreddit, enabled, last_scanned_at, last_error FROM watchers ORDER BY subreddit").all()).results;
  return json({
    settings, reddit: { configured: reddit.isConfigured(env), connected: Boolean(acct), account: acct || null, rate: await reddit.getRateState(db) },
    counts, pending_review: (counts.suggested || 0) + (counts.draft || 0), in_flight: (counts.queued || 0) + (counts.submitting || 0) + (counts.handoff || 0),
    opportunities, failures: failures.map(({ content_json, ...f }) => ({ ...f, title: parseJSON(content_json, {}).title || "" })),
    cooldowns, daily: { used: used.n, cap: settings.daily_cap }, watchers, server_time: t,
  });
});

route("GET", "/api/settings", async ({ env }) => json(await getSettings(env.DB)));
route("PUT", "/api/settings", async ({ env, request, admin }) => {
  const b = await body(request);
  const allowed = {
    daily_cap: (v) => String(int(v, 3, 0, 20)), min_gap_minutes: (v) => String(int(v, 20, 0, 1440)),
    approval_ttl_minutes: (v) => String(int(v, 30, 5, 240)), duplicate_window_days: (v) => String(int(v, 30, 0, 365)),
    submit_mode: (v) => (v === "handoff" ? "handoff" : "api"), kill_switch: (v) => String(bool(v)),
  };
  const stmts = [];
  for (const [k, f] of Object.entries(allowed)) if (k in b) stmts.push(env.DB.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, f(b[k])));
  if (stmts.length) await env.DB.batch(stmts);
  await audit(env.DB, actorOf(admin), "settings.updated", "settings", null, b);
  return json(await getSettings(env.DB));
});

/* ---- Reddit OAuth ---- */
route("GET", "/api/reddit/status", async ({ env }) => {
  const acct = await env.DB.prepare("SELECT username, scopes, connected_at FROM reddit_accounts WHERE id = 1").first();
  return json({ configured: reddit.isConfigured(env), connected: Boolean(acct), account: acct, scopes_requested: reddit.SCOPES, rate: await reddit.getRateState(env.DB) });
});
route("POST", "/api/reddit/connect", async ({ env, admin }) => {
  if (!reddit.isConfigured(env)) throw new HttpError(409, "Reddit app credentials aren't set on the Worker yet (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, TOKEN_ENC_KEY).");
  const state = randomId(24);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now()),
    env.DB.prepare("INSERT INTO oauth_states (state, admin_id, created_at, expires_at) VALUES (?,?,?,?)").bind(state, admin.id, now(), now() + 10 * 60_000),
  ]);
  await audit(env.DB, actorOf(admin), "reddit.connect_started", null, null, { scopes: reddit.SCOPES });
  return json({ url: reddit.authorizeUrl(env, state) });
});
route("GET", "/api/reddit/callback", async ({ env, url }) => {
  const back = (q) => Response.redirect(`${env.ADS_ORIGIN || "https://osprey.build"}/ads/?${q}`, 302);
  const state = url.searchParams.get("state"), code = url.searchParams.get("code");
  const row = state ? await env.DB.prepare("SELECT * FROM oauth_states WHERE state = ?").bind(state).first() : null;
  if (state) await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
  if (!row || row.expires_at < now()) return back("reddit=bad_state");
  if (url.searchParams.get("error") || !code) { await audit(env.DB, "system", "reddit.connect_denied", null, null, { error: url.searchParams.get("error") }); return back("reddit=denied"); }
  try {
    const name = await reddit.exchangeCode(env, env.DB, code, row.admin_id);
    await audit(env.DB, `admin_id:${row.admin_id}`, "reddit.connected", "reddit_account", name);
    return back("reddit=connected");
  } catch (e) {
    await audit(env.DB, "system", "reddit.connect_failed", null, null, { error: String(e.message || e) });
    return back("reddit=error");
  }
}, { public: true });
route("POST", "/api/reddit/disconnect", async ({ env, admin }) => {
  await env.DB.prepare("DELETE FROM reddit_accounts WHERE id = 1").run();
  await audit(env.DB, actorOf(admin), "reddit.disconnected");
  return json({ ok: true });
});
route("POST", "/api/reddit/thread", async ({ env, request }) => {
  const b = await body(request);
  const ref = parseThreadRef(b.url);
  if (!ref) throw new HttpError(400, "That doesn't look like a Reddit thread link.");
  if (!(await env.DB.prepare("SELECT 1 AS x FROM reddit_accounts WHERE id = 1").first())) return json({ ...ref, title: null });
  const p = await reddit.getThread(env, env.DB, ref.fullname);
  return json(p ? { fullname: p.name, subreddit: normSub(p.subreddit), title: p.title, permalink: "https://www.reddit.com" + p.permalink, author: p.author, locked: p.locked, archived: p.archived } : { ...ref, title: null });
});

/* ---- templates ---- */
const tplOut = (r) => ({ ...r, content: parseJSON(r.content_json, {}), content_json: undefined });
route("GET", "/api/templates", async ({ env }) => json({ templates: (await env.DB.prepare("SELECT * FROM templates WHERE archived = 0 ORDER BY kind, name").all()).results.map(tplOut) }));
route("POST", "/api/templates", async ({ env, request, admin }) => {
  const b = await body(request);
  if (!b.name || !["post", "reply"].includes(b.kind)) throw new HttpError(400, "Templates need a name and a kind (post or reply).");
  const t = now();
  const r = await env.DB.prepare("INSERT INTO templates (name, kind, content_json, notes, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(String(b.name).slice(0, 120), b.kind, JSON.stringify(normalizeContent(b.content)), b.notes || null, admin.id, t, t).run();
  await audit(env.DB, actorOf(admin), "template.created", "template", r.meta.last_row_id, { name: b.name });
  return json({ id: r.meta.last_row_id }, 201);
});
route("PUT", "/api/templates/:id", async ({ env, request, admin, params }) => {
  const b = await body(request);
  await env.DB.prepare("UPDATE templates SET name = ?, kind = ?, content_json = ?, notes = ?, updated_at = ? WHERE id = ?")
    .bind(String(b.name).slice(0, 120), b.kind === "reply" ? "reply" : "post", JSON.stringify(normalizeContent(b.content)), b.notes || null, now(), params.id).run();
  await audit(env.DB, actorOf(admin), "template.updated", "template", params.id);
  return json({ ok: true });
});
route("DELETE", "/api/templates/:id", async ({ env, admin, params }) => {
  await env.DB.prepare("UPDATE templates SET archived = 1, updated_at = ? WHERE id = ?").bind(now(), params.id).run();
  await audit(env.DB, actorOf(admin), "template.archived", "template", params.id);
  return json({ ok: true });
});

/* ---- drafts ---- */
route("GET", "/api/drafts", async ({ env, url }) => {
  const db = env.DB;
  const statuses = (url.searchParams.get("status") || "suggested,draft,queued,submitting,handoff,failed").split(",").filter(Boolean);
  const { results } = await db.prepare(`SELECT * FROM drafts WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT 100`).bind(...statuses).all();
  const settings = await getSettings(db);
  const acct = await db.prepare("SELECT username FROM reddit_accounts WHERE id = 1").first();
  const connected = Boolean(acct);
  const out = [];
  for (const r of results) out.push(await draftView(env, db, r, settings, connected));
  return json({ drafts: out, settings, reddit_connected: connected, reddit_username: acct?.username || null, server_time: now() });
});
route("GET", "/api/drafts/:id", async ({ env, params }) => {
  const d = await loadDraft(env.DB, params.id);
  if (!d) throw new HttpError(404, "Draft not found.");
  const settings = await getSettings(env.DB);
  return json(await draftView(env, env.DB, d, settings, Boolean(await env.DB.prepare("SELECT 1 AS x FROM reddit_accounts WHERE id = 1").first())));
});
route("POST", "/api/drafts", async ({ env, request, admin }) => {
  const b = await body(request);
  const d = await hydrateDraft(b);
  if (!["post", "reply"].includes(d.kind)) throw new HttpError(400, "Choose post or reply.");
  const t = now();
  const r = await env.DB.prepare(`INSERT INTO drafts (kind, subreddit, thread_fullname, thread_title, thread_permalink, content_json, content_hash, text_fingerprint, status, template_id, candidate_id, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?, 'draft', ?,?,?,?,?)`)
    .bind(d.kind, d.subreddit, d.thread_fullname, d.thread_title, d.thread_permalink, JSON.stringify(d.content), d.content_hash, d.text_fingerprint,
      b.template_id || null, b.candidate_id || null, admin.id, t, t).run();
  if (b.candidate_id) await env.DB.prepare("UPDATE candidate_opportunities SET status = 'drafted' WHERE id = ?").bind(b.candidate_id).run();
  await audit(env.DB, actorOf(admin), "draft.created", "draft", r.meta.last_row_id, { content_hash: d.content_hash, subreddit: d.subreddit, kind: d.kind });
  return json({ id: r.meta.last_row_id, content_hash: d.content_hash }, 201);
});
route("PUT", "/api/drafts/:id", async ({ env, request, admin, params }) => {
  const db = env.DB;
  const ex = await loadDraft(db, params.id);
  if (!ex) throw new HttpError(404, "Draft not found.");
  if (["submitting", "submitted"].includes(ex.status)) throw new HttpError(409, "This draft has already been sent and can't be edited. Duplicate it instead.");
  const b = await body(request);
  const d = await hydrateDraft(b, ex);
  const changed = d.content_hash !== ex.content_hash;
  const t = now();
  const stmts = [db.prepare(`UPDATE drafts SET kind = ?, subreddit = ?, thread_fullname = ?, thread_title = ?, thread_permalink = ?, content_json = ?, content_hash = ?, text_fingerprint = ?,
      version = version + ?, status = CASE WHEN ? THEN 'draft' ELSE status END, reject_reason = CASE WHEN ? THEN NULL ELSE reject_reason END, updated_at = ? WHERE id = ?`)
    .bind(d.kind, d.subreddit, d.thread_fullname, d.thread_title, d.thread_permalink, JSON.stringify(d.content), d.content_hash, d.text_fingerprint,
      changed ? 1 : 0, changed ? 1 : 0, changed ? 1 : 0, t, ex.id)];
  // Any edit to the payload revokes outstanding approvals for the old content.
  if (changed) stmts.push(db.prepare("UPDATE approvals SET status = 'revoked', status_reason = 'draft edited after approval' WHERE draft_id = ? AND status = 'active'").bind(ex.id));
  await db.batch(stmts);
  await audit(db, actorOf(admin), "draft.edited", "draft", ex.id, { from_hash: ex.content_hash, to_hash: d.content_hash, approvals_revoked: changed });
  return json({ ok: true, content_hash: d.content_hash, changed });
});

route("POST", "/api/drafts/:id/approve", async ({ env, request, admin, params }) => {
  const db = env.DB;
  const b = await body(request);
  const d = await loadDraft(db, params.id);
  if (!d) throw new HttpError(404, "Draft not found.");
  if (!["suggested", "draft", "failed"].includes(d.status)) throw new HttpError(409, `A ${d.status} draft can't be approved.`);
  // The browser sends the hash of exactly what it showed you; it has to match the stored draft.
  const serverHash = await contentHash(d);
  if (b.content_hash !== serverHash || d.content_hash !== serverHash || Number(b.version) !== d.version)
    throw new HttpError(409, "This draft changed since you loaded it. Reload and review it again.");
  d.text_fingerprint = await textFingerprint(d);
  const settings = await getSettings(db);
  const mode = settings.submit_mode;
  const connected = Boolean(await db.prepare("SELECT 1 AS x FROM reddit_accounts WHERE id = 1").first());
  const policy = await evaluate(db, d, { settings, phase: "approve", mode, redditConnected: connected });
  if (policy.blocks.length) {
    await audit(db, actorOf(admin), "approval.refused", "draft", d.id, { blocks: policy.blocks.map((x) => x.code) });
    throw new HttpError(422, "Blocked: " + policy.blocks.map((x) => x.message).join(" "), { blocks: policy.blocks });
  }
  const t = now();
  const expires = t + settings.approval_ttl_minutes * 60_000;
  const gap = policy.waits.find((w) => w.code === "min_gap");
  if (mode === "api" && gap && gap.until >= expires) throw new HttpError(422, gap.message + " That's later than the approval would last, so approve it closer to then.");
  const id = randomId(18);
  await db.batch([
    db.prepare("UPDATE approvals SET status = 'revoked', status_reason = 'superseded' WHERE draft_id = ? AND status = 'active'").bind(d.id),
    db.prepare("INSERT INTO approvals (id, draft_id, draft_version, content_hash, mode, status, approved_by, approved_at, expires_at) VALUES (?,?,?,?,?, 'active', ?,?,?)")
      .bind(id, d.id, d.version, serverHash, mode, admin.id, t, expires),
    db.prepare("UPDATE drafts SET status = ?, reject_reason = NULL, updated_at = ? WHERE id = ? AND content_hash = ? AND version = ?")
      .bind(mode === "api" ? "queued" : "handoff", t, d.id, serverHash, d.version),
  ]);
  if (mode === "api") await env.SUBMISSIONS.send({ approval_id: id }, gap ? { delaySeconds: Math.ceil((gap.until - t) / 1000) + 2 } : undefined);
  await audit(db, actorOf(admin), "approval.granted", "draft", d.id, { approval_id: id, content_hash: serverHash, version: d.version, mode, expires_at: expires });
  return json({ approval_id: id, mode, expires_at: expires, payload: buildPayload(d) });
});

route("POST", "/api/drafts/:id/reject", async ({ env, request, admin, params }) => {
  const b = await body(request).catch(() => ({}));
  const db = env.DB;
  const d = await loadDraft(db, params.id);
  if (!d) throw new HttpError(404, "Draft not found.");
  if (["submitting", "submitted"].includes(d.status)) throw new HttpError(409, "Already sent.");
  await db.batch([
    db.prepare("UPDATE drafts SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?").bind(String(b.reason || "").slice(0, 300) || null, now(), d.id),
    db.prepare("UPDATE approvals SET status = 'revoked', status_reason = 'draft rejected' WHERE draft_id = ? AND status = 'active'").bind(d.id),
  ]);
  await audit(db, actorOf(admin), "draft.rejected", "draft", d.id, { reason: b.reason || null });
  return json({ ok: true });
});

route("POST", "/api/drafts/:id/duplicate", async ({ env, admin, params }) => {
  const db = env.DB;
  const d = await loadDraft(db, params.id);
  if (!d) throw new HttpError(404, "Draft not found.");
  const t = now();
  const r = await db.prepare(`INSERT INTO drafts (kind, subreddit, thread_fullname, thread_title, thread_permalink, content_json, content_hash, text_fingerprint, status, template_id, candidate_id, created_by, created_at, updated_at)
      SELECT kind, subreddit, thread_fullname, thread_title, thread_permalink, content_json, content_hash, text_fingerprint, 'draft', template_id, NULL, ?, ?, ? FROM drafts WHERE id = ?`)
    .bind(admin.id, t, t, d.id).run();
  await audit(db, actorOf(admin), "draft.duplicated", "draft", r.meta.last_row_id, { from: d.id });
  return json({ id: r.meta.last_row_id }, 201);
});

/* ---- manual hand-off ---- */
route("POST", "/api/approvals/:id/complete", async ({ env, request, admin, params }) => {
  const db = env.DB;
  const b = await body(request);
  const ref = parseThreadRef(b.permalink) || /reddit\.com\/r\/[^/]+\/comments\//i.test(b.permalink || "");
  if (!ref) throw new HttpError(400, "Paste the reddit.com link to what you posted.");
  const v = await verifyApproval(env, db, params.id, { phase: "submit" });
  if (v.fail) throw new HttpError(409, v.fail);
  if (v.approval.mode !== "handoff") throw new HttpError(409, "This approval is handled by the submission worker.");
  const t = now();
  await db.batch([
    db.prepare("UPDATE approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'active'").bind(t, v.approval.id),
    db.prepare("UPDATE drafts SET status = 'submitted', updated_at = ? WHERE id = ?").bind(t, v.draft.id),
    db.prepare(`INSERT INTO submissions (draft_id, approval_id, kind, subreddit, content_hash, text_fingerprint, status, permalink, mode, created_at)
      VALUES (?,?,?,?,?,?, 'submitted', ?, 'handoff', ?)`)
      .bind(v.draft.id, v.approval.id, v.draft.kind, v.draft.subreddit, v.approval.content_hash, v.draft.text_fingerprint, String(b.permalink).slice(0, 500), t),
  ]);
  if (v.draft.candidate_id) await db.prepare("UPDATE candidate_opportunities SET status = 'drafted' WHERE id = ?").bind(v.draft.candidate_id).run();
  await audit(db, actorOf(admin), "submission.handoff_recorded", "draft", v.draft.id, { approval_id: v.approval.id, permalink: b.permalink });
  return json({ ok: true });
});
route("POST", "/api/approvals/:id/cancel", async ({ env, admin, params }) => {
  const db = env.DB;
  const a = await db.prepare("SELECT * FROM approvals WHERE id = ?").bind(params.id).first();
  if (!a) throw new HttpError(404, "Approval not found.");
  const r = await db.prepare("UPDATE approvals SET status = 'revoked', status_reason = 'cancelled by admin' WHERE id = ? AND status = 'active'").bind(a.id).run();
  if (r.meta.changes) await db.prepare("UPDATE drafts SET status = 'draft', updated_at = ? WHERE id = ? AND status IN ('queued','handoff')").bind(now(), a.draft_id).run();
  await audit(db, actorOf(admin), "approval.cancelled", "approval", a.id, { draft_id: a.draft_id, changed: r.meta.changes });
  return json({ ok: Boolean(r.meta.changes) });
});

/* ---- candidates ---- */
route("GET", "/api/candidates", async ({ env, url }) => {
  const st = url.searchParams.get("status") || "new";
  return json({ candidates: (await env.DB.prepare("SELECT * FROM candidate_opportunities WHERE status = ? ORDER BY created_at DESC LIMIT 100").bind(st).all()).results });
});
route("POST", "/api/candidates", async ({ env, request, admin }) => {
  const b = await body(request);
  const ref = parseThreadRef(b.url);
  if (!ref) throw new HttpError(400, "Paste a Reddit thread link.");
  const sub = normSub(b.subreddit || ref.subreddit);
  if (!sub) throw new HttpError(400, "Couldn't tell which subreddit this is. Add it.");
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO candidate_opportunities (subreddit, reddit_fullname, title, permalink, status, source, created_at)
      VALUES (?,?,?,?, 'new', 'manual', ?)`).bind(sub, ref.fullname, String(b.title || "(title not fetched)").slice(0, 300), String(b.url), now()).run();
  if (!r.meta.changes) throw new HttpError(409, "That thread is already in the list.");
  await audit(env.DB, actorOf(admin), "candidate.added", "candidate", r.meta.last_row_id, { url: b.url });
  return json({ id: r.meta.last_row_id }, 201);
});
route("POST", "/api/candidates/:id/dismiss", async ({ env, admin, params }) => {
  await env.DB.prepare("UPDATE candidate_opportunities SET status = 'dismissed' WHERE id = ?").bind(params.id).run();
  await audit(env.DB, actorOf(admin), "candidate.dismissed", "candidate", params.id);
  return json({ ok: true });
});

/* ---- subreddit rules ---- */
route("GET", "/api/subreddits", async ({ env }) => json({ rules: (await env.DB.prepare("SELECT * FROM subreddit_rules ORDER BY blacklisted, subreddit").all()).results }));
route("PUT", "/api/subreddits/:name", async ({ env, request, admin, params }) => {
  const sub = normSub(decodeURIComponent(params.name));
  if (!/^[a-z0-9_]{2,21}$/.test(sub)) throw new HttpError(400, "Enter a valid subreddit name.");
  const b = await body(request);
  const t = now();
  const v = {
    ads_allowed: bool(b.ads_allowed), comments_allowed: bool(b.comments_allowed), weekly_thread_only: bool(b.weekly_thread_only),
    weekly_thread_match: (b.weekly_thread_match || "").trim() || null, required_flair: bool(b.required_flair),
    flair_id: (b.flair_id || "").trim() || null, flair_text: (b.flair_text || "").trim() || null,
    cooldown_hours: int(b.cooldown_hours, 168, 0, 24 * 90), max_per_day: int(b.max_per_day, 1, 0, 10),
    blacklisted: bool(b.blacklisted), paused: bool(b.paused), rules_url: (b.rules_url || "").trim() || null, notes: (b.notes || "").trim() || null,
  };
  await env.DB.prepare(`INSERT INTO subreddit_rules (subreddit, ads_allowed, comments_allowed, weekly_thread_only, weekly_thread_match, required_flair, flair_id, flair_text,
      cooldown_hours, max_per_day, blacklisted, paused, rules_url, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(subreddit) DO UPDATE SET ads_allowed=excluded.ads_allowed, comments_allowed=excluded.comments_allowed, weekly_thread_only=excluded.weekly_thread_only,
      weekly_thread_match=excluded.weekly_thread_match, required_flair=excluded.required_flair, flair_id=excluded.flair_id, flair_text=excluded.flair_text,
      cooldown_hours=excluded.cooldown_hours, max_per_day=excluded.max_per_day, blacklisted=excluded.blacklisted, paused=excluded.paused,
      rules_url=excluded.rules_url, notes=excluded.notes, updated_at=excluded.updated_at`)
    .bind(sub, v.ads_allowed, v.comments_allowed, v.weekly_thread_only, v.weekly_thread_match, v.required_flair, v.flair_id, v.flair_text,
      v.cooldown_hours, v.max_per_day, v.blacklisted, v.paused, v.rules_url, v.notes, t, t).run();
  if (v.blacklisted) await env.DB.prepare("UPDATE watchers SET enabled = 0 WHERE subreddit = ?").bind(sub).run();
  await audit(env.DB, actorOf(admin), "subreddit_rule.saved", "subreddit_rule", sub, v);
  return json({ ok: true });
});
route("POST", "/api/subreddits/:name/pause", async ({ env, request, admin, params }) => {
  const sub = normSub(decodeURIComponent(params.name));
  const b = await body(request).catch(() => ({}));
  const paused = b.paused === false ? 0 : 1;
  const r = await env.DB.prepare("UPDATE subreddit_rules SET paused = ?, updated_at = ? WHERE subreddit = ?").bind(paused, now(), sub).run();
  if (!r.meta.changes) throw new HttpError(404, `r/${sub} has no rule yet.`);
  await audit(env.DB, actorOf(admin), paused ? "subreddit.paused" : "subreddit.resumed", "subreddit_rule", sub);
  return json({ ok: true, paused: Boolean(paused) });
});
route("DELETE", "/api/subreddits/:name", async ({ env, admin, params }) => {
  const sub = normSub(decodeURIComponent(params.name));
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM watchers WHERE subreddit = ?").bind(sub).first();
  if (used.n) throw new HttpError(409, "Delete this subreddit's watchers first, or blacklist it instead.");
  await env.DB.prepare("DELETE FROM subreddit_rules WHERE subreddit = ?").bind(sub).run();
  await audit(env.DB, actorOf(admin), "subreddit_rule.deleted", "subreddit_rule", sub);
  return json({ ok: true });
});

/* ---- watchers ---- */
route("GET", "/api/watchers", async ({ env }) => json({
  watchers: (await env.DB.prepare("SELECT * FROM watchers ORDER BY subreddit").all()).results.map((w) => ({ ...w, keywords: parseJSON(w.keywords_json, []), exclude: parseJSON(w.exclude_json, []) })),
  default_keywords: DEFAULT_KEYWORDS,
}));
async function saveWatcher(env, b, id) {
  const sub = normSub(b.subreddit);
  const rule = await env.DB.prepare("SELECT * FROM subreddit_rules WHERE subreddit = ?").bind(sub).first();
  if (!rule) throw new HttpError(400, `Add rules for r/${sub} first. Watchers only run on subreddits you've added.`);
  if (rule.blacklisted) throw new HttpError(400, `r/${sub} is blacklisted.`);
  const list = (v) => (Array.isArray(v) ? v : String(v || "").split("\n")).map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
  const kw = list(b.keywords);
  const vals = [sub, JSON.stringify(kw.length ? kw : DEFAULT_KEYWORDS), JSON.stringify(list(b.exclude)), b.template_id ? Number(b.template_id) : null,
    int(b.max_age_hours, 48, 1, 168), int(b.interval_minutes, 60, 15, 1440), b.enabled === undefined ? 1 : bool(b.enabled), now()];
  if (id) await env.DB.prepare("UPDATE watchers SET subreddit=?, keywords_json=?, exclude_json=?, template_id=?, max_age_hours=?, interval_minutes=?, enabled=?, updated_at=? WHERE id=?").bind(...vals, id).run();
  else return (await env.DB.prepare("INSERT INTO watchers (subreddit, keywords_json, exclude_json, template_id, max_age_hours, interval_minutes, enabled, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(...vals, now()).run()).meta.last_row_id;
  return id;
}
route("POST", "/api/watchers", async ({ env, request, admin }) => {
  const id = await saveWatcher(env, await body(request));
  await audit(env.DB, actorOf(admin), "watcher.created", "watcher", id);
  return json({ id }, 201);
});
route("PUT", "/api/watchers/:id", async ({ env, request, admin, params }) => {
  await saveWatcher(env, await body(request), params.id);
  await audit(env.DB, actorOf(admin), "watcher.updated", "watcher", params.id);
  return json({ ok: true });
});
route("DELETE", "/api/watchers/:id", async ({ env, admin, params }) => {
  await env.DB.prepare("DELETE FROM watchers WHERE id = ?").bind(params.id).run();
  await audit(env.DB, actorOf(admin), "watcher.deleted", "watcher", params.id);
  return json({ ok: true });
});
route("POST", "/api/watchers/:id/scan", async ({ env, admin, params }) => {
  const w = await env.DB.prepare("SELECT * FROM watchers WHERE id = ?").bind(params.id).first();
  if (!w) throw new HttpError(404, "Watcher not found.");
  try { return json(await scanWatcher(env, env.DB, w, actorOf(admin))); }
  catch (e) { if (e instanceof reddit.RateLimitError) throw new HttpError(429, `Reddit rate limit: try again in ${e.delaySeconds}s.`); throw e; }
});
route("POST", "/api/candidates/:id/draft", async ({ env, request, admin, params }) => {
  const b = await body(request).catch(() => ({}));
  const c = await env.DB.prepare("SELECT * FROM candidate_opportunities WHERE id = ?").bind(params.id).first();
  if (!c) throw new HttpError(404, "Opportunity not found.");
  const tpl = b.template_id ? await env.DB.prepare("SELECT * FROM templates WHERE id = ?").bind(b.template_id).first()
    : { id: null, content_json: JSON.stringify({ body: "", cta: "" }) };
  const id = await suggestDraft(env.DB, tpl, { id: c.id, subreddit: c.subreddit, fullname: c.reddit_fullname, title: c.title, permalink: c.permalink, author: c.author }, admin.id, "draft");
  await audit(env.DB, actorOf(admin), "draft.created", "draft", id, { from_candidate: c.id, template_id: tpl.id });
  return json({ id }, 201);
});

/* ---- history / audit ---- */
route("GET", "/api/history", async ({ env, url }) => {
  const st = url.searchParams.get("status");
  const sql = `SELECT s.*, d.content_json, d.thread_title, d.thread_permalink, a.approved_at, a.expires_at, u.username AS approved_by
    FROM submissions s JOIN drafts d ON d.id = s.draft_id JOIN approvals a ON a.id = s.approval_id LEFT JOIN admin_users u ON u.id = a.approved_by
    ${st ? "WHERE s.status = ?" : ""} ORDER BY s.created_at DESC LIMIT 200`;
  const q = env.DB.prepare(sql);
  const { results } = await (st ? q.bind(st) : q).all();
  return json({ submissions: results.map(({ content_json, ...r }) => ({ ...r, title: parseJSON(content_json, {}).title || "" })) });
});
route("GET", "/api/audit", async ({ env, url }) => {
  const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT 100").bind(before).all();
  return json({ entries: results.map((r) => ({ ...r, detail: parseJSON(r.detail_json, null), detail_json: undefined })) });
});

/* ---------------- entry ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ch = cors(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: ch });
    try {
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const admin = r.public ? null : await requireAdmin(request, env.DB);
        const res = await r.handler({ env, request, url, admin, params: m.groups || {} });
        for (const [k, v] of Object.entries(ch)) res.headers.set(k, v);
        return res;
      }
      return json({ error: "Not found" }, 404, ch);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status, ch);
      console.error(e);
      return json({ error: "Something went wrong on the server." }, 500, ch);
    }
  },
};
