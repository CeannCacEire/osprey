/* End-to-end test against a real local D1 (via wrangler's platform proxy) and a mocked Reddit. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getPlatformProxy } from "wrangler";
import api from "../src/api.js";
import { processApproval } from "../src/lib/submit.js";
import { runDueWatchers } from "../src/lib/watch.js";

let proxy, env, queued = [], redditCalls = [], rateHeaders = { remaining: "95", used: "5", reset: "300" }, force429 = false;
const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const realFetch = globalThis.fetch;

function mockReddit(url, init = {}) {
  const u = new URL(url);
  const h = { "content-type": "application/json", "x-ratelimit-remaining": rateHeaders.remaining, "x-ratelimit-used": rateHeaders.used, "x-ratelimit-reset": rateHeaders.reset };
  const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: h });
  if (u.hostname === "mock.reddit" && u.pathname === "/token") return ok({ access_token: "AT" + Date.now(), refresh_token: "RT1", expires_in: 3600, scope: "identity read submit" });
  if (u.hostname !== "mock.oauth") return realFetch(url, init);
  redditCalls.push({ method: init.method, path: u.pathname, body: init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null, ua: init.headers["User-Agent"] });
  if (force429) return ok({ message: "Too Many Requests" }, 429);
  if (u.pathname === "/api/v1/me") return ok({ name: "osprey_admin" });
  if (u.pathname === "/r/admincraft/new") return ok({ data: { children: [
    { data: { name: "t3_aaa", subreddit: "admincraft", title: "Looking for a server with Java and Bedrock", selftext: "any server recommendations?", author: "player1", permalink: "/r/admincraft/comments/aaa/x/", created_utc: Date.now() / 1000 - 600 } },
    { data: { name: "t3_bbb", subreddit: "admincraft", title: "My redstone build", selftext: "", author: "p2", permalink: "/r/admincraft/comments/bbb/y/", created_utc: Date.now() / 1000 - 600 } },
  ] } });
  if (u.pathname === "/api/comment") return ok({ json: { errors: [], data: { things: [{ data: { name: "t1_ccc", id: "ccc", permalink: "/r/admincraft/comments/aaa/x/ccc/" } }] } } });
  if (u.pathname === "/api/submit") return ok({ json: { errors: [], data: { name: "t3_new", url: "https://www.reddit.com/r/mcservers/comments/new/osprey/" } } });
  return ok({ error: "unmocked " + u.pathname }, 404);
}

let token;
async function call(method, path, body, auth = true) {
  const res = await api.fetch(new Request("https://api.test" + path, {
    method, headers: { "Content-Type": "application/json", Origin: "https://osprey.build", ...(auth && token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}
// Same hash the browser would compute from what it displays.
const viewHash = async (id) => (await call("GET", "/api/drafts/" + id)).data;

before(async () => {
  proxy = await getPlatformProxy({ configPath: "wrangler.api.toml", persist: { path: ".wrangler/test/v3" } });
  env = { ...proxy.env, SUBMISSIONS: { send: async (m, o) => queued.push({ m, o }) }, ADMIN_SETUP_TOKEN: "setup-123",
    REDDIT_CLIENT_ID: "cid", REDDIT_CLIENT_SECRET: "sec", TOKEN_ENC_KEY: KEY, REDDIT_USERNAME: "osprey_admin",
    REDDIT_API_BASE: "https://mock.oauth", REDDIT_TOKEN_URL: "https://mock.reddit/token", API_ORIGIN: "https://api.test" };
  globalThis.fetch = mockReddit;
});
after(async () => { globalThis.fetch = realFetch; await proxy?.dispose(); });

test("auth: setup, login, protected routes", async () => {
  assert.equal((await call("GET", "/api/dashboard", null, false)).status, 401);
  assert.equal((await call("POST", "/api/setup", { setup_token: "nope", username: "genocchi", password: "correct horse battery" }, false)).status, 403);
  assert.equal((await call("POST", "/api/setup", { setup_token: "setup-123", username: "genocchi", password: "short" }, false)).status, 400);
  assert.equal((await call("POST", "/api/setup", { setup_token: "setup-123", username: "genocchi", password: "correct horse battery" }, false)).status, 200);
  assert.equal((await call("POST", "/api/setup", { setup_token: "setup-123", username: "x2", password: "correct horse battery" }, false)).status, 409);
  assert.equal((await call("POST", "/api/login", { username: "genocchi", password: "wrong password!!" }, false)).status, 401);
  const r = await call("POST", "/api/login", { username: "genocchi", password: "correct horse battery" }, false);
  assert.equal(r.status, 200); token = r.data.token;
  assert.equal(r.headers.get("access-control-allow-origin"), "https://osprey.build");
  assert.equal((await call("GET", "/api/me")).data.admin.username, "genocchi");
});

test("reddit OAuth connect + callback stores encrypted tokens", async () => {
  const c = await call("POST", "/api/reddit/connect");
  const u = new URL(c.data.url);
  assert.equal(u.searchParams.get("scope"), "identity read submit");
  assert.equal(u.searchParams.get("duration"), "permanent");
  const cb = await api.fetch(new Request(`https://api.test/api/reddit/callback?state=${u.searchParams.get("state")}&code=abc`), env);
  assert.equal(cb.status, 302); assert.match(cb.headers.get("location"), /reddit=connected/);
  const acct = await env.DB.prepare("SELECT * FROM reddit_accounts").first();
  assert.equal(acct.username, "osprey_admin"); assert.ok(!acct.refresh_token_enc.includes("RT1"));
  const replay = await api.fetch(new Request(`https://api.test/api/reddit/callback?state=${u.searchParams.get("state")}&code=abc`), env);
  assert.match(replay.headers.get("location"), /bad_state/);
});

test("no rule = blocked; watcher refuses unknown subreddits", async () => {
  const w = await call("POST", "/api/watchers", { subreddit: "admincraft" });
  assert.equal(w.status, 400);
  const d = await call("POST", "/api/drafts", { kind: "post", subreddit: "randomsub", content: { title: "Osprey", body: "Come play" } });
  const v = await viewHash(d.data.id);
  assert.ok(v.blocks.some((b) => b.code === "no_rule"));
  const a = await call("POST", `/api/drafts/${d.data.id}/approve`, { content_hash: v.content_hash, version: v.version });
  assert.equal(a.status, 422);
});

test("watcher creates candidates + suggested drafts only, never queues", async () => {
  await call("PUT", "/api/subreddits/admincraft", { comments_allowed: true, cooldown_hours: 24, max_per_day: 1 });
  const tpl = await call("POST", "/api/templates", { name: "Server rec reply", kind: "reply", content: { body: "Hey u/{{author}}, you might like Osprey.", cta: "Discord: https://discord.gg/4EnjKHUG4S" } });
  const w = await call("POST", "/api/watchers", { subreddit: "admincraft", template_id: tpl.data.id });
  assert.equal(w.status, 201);
  await runDueWatchers(env, env.DB);
  const cands = (await env.DB.prepare("SELECT * FROM candidate_opportunities WHERE source='watcher'").all()).results;
  assert.equal(cands.length, 1); assert.equal(cands[0].reddit_fullname, "t3_aaa");
  const drafts = (await env.DB.prepare("SELECT * FROM drafts WHERE candidate_id = ?").bind(cands[0].id).all()).results;
  assert.equal(drafts.length, 1); assert.equal(drafts[0].status, "suggested");
  assert.match(JSON.parse(drafts[0].content_json).body, /u\/player1/);
  assert.equal(queued.length, 0);
  assert.ok(!redditCalls.some((c) => c.method === "POST"), "watcher must not POST to Reddit");
  const rs = await env.DB.prepare("SELECT * FROM rate_state").first();
  assert.equal(rs.remaining, 95);
});

test("approval: stale hash refused; edit after approval is rejected by worker", async () => {
  const d = (await env.DB.prepare("SELECT id FROM drafts WHERE status='suggested'").first()).id;
  let v = await viewHash(d);
  assert.equal((await call("POST", `/api/drafts/${d}/approve`, { content_hash: "deadbeef", version: v.version })).status, 409);
  const ok = await call("POST", `/api/drafts/${d}/approve`, { content_hash: v.content_hash, version: v.version });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const approvalId = ok.data.approval_id;
  // Tamper directly in the DB (simulates any path that changes content after approval)
  const row = await env.DB.prepare("SELECT content_json FROM drafts WHERE id = ?").bind(d).first();
  const c = JSON.parse(row.content_json); c.body += " EXTRA";
  await env.DB.prepare("UPDATE drafts SET content_json = ? WHERE id = ?").bind(JSON.stringify(c), d).run();
  const before = redditCalls.length;
  const r = await processApproval(env, env.DB, approvalId);
  assert.equal(r.outcome, "blocked"); assert.match(r.reason, /changed after approval/);
  assert.equal(redditCalls.length, before, "no Reddit call");
  assert.equal((await env.DB.prepare("SELECT status FROM approvals WHERE id = ?").bind(approvalId).first()).status, "revoked");
});

test("approval: edit through API revokes; expired approval rejected; happy path submits once", async () => {
  const d = (await env.DB.prepare("SELECT id FROM drafts WHERE kind='reply' ORDER BY id LIMIT 1").first()).id;
  // fix content via API (re-hashes) and re-approve
  await call("PUT", `/api/drafts/${d}`, { content: { body: "Hey, Osprey is a finite-island civilisation server.", cta: "Discord: https://discord.gg/4EnjKHUG4S" } });
  let v = await viewHash(d);
  let a = await call("POST", `/api/drafts/${d}/approve`, { content_hash: v.content_hash, version: v.version });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  // edit via API -> approval revoked
  await call("PUT", `/api/drafts/${d}`, { content: { body: "Changed again.", cta: "" } });
  assert.equal((await env.DB.prepare("SELECT status FROM approvals WHERE id = ?").bind(a.data.approval_id).first()).status, "revoked");
  assert.equal((await processApproval(env, env.DB, a.data.approval_id)).outcome, "skipped");
  // expiry
  v = await viewHash(d);
  a = await call("POST", `/api/drafts/${d}/approve`, { content_hash: v.content_hash, version: v.version });
  await env.DB.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, a.data.approval_id).run();
  const ex = await processApproval(env, env.DB, a.data.approval_id);
  assert.equal(ex.outcome, "blocked"); assert.match(ex.reason, /expired/);
  // 429 -> deferred, approval stays active, nothing recorded as sent
  v = await viewHash(d);
  a = await call("POST", `/api/drafts/${d}/approve`, { content_hash: v.content_hash, version: v.version });
  force429 = true; rateHeaders = { remaining: "0", used: "100", reset: "30" };
  const def = await processApproval(env, env.DB, a.data.approval_id);
  assert.equal(def.outcome, "deferred"); assert.ok(def.delaySeconds >= 5);
  // the window is still exhausted: next attempt defers without calling Reddit at all
  const n = redditCalls.length;
  assert.equal((await processApproval(env, env.DB, a.data.approval_id)).outcome, "deferred");
  assert.equal(redditCalls.length, n, "budget check prevented the call");
  force429 = false; rateHeaders = { remaining: "90", used: "10", reset: "200" };
  await env.DB.prepare("UPDATE rate_state SET remaining = 90").run();
  const okr = await processApproval(env, env.DB, a.data.approval_id);
  assert.equal(okr.outcome, "submitted", JSON.stringify(okr));
  const sub = await env.DB.prepare("SELECT * FROM submissions WHERE approval_id = ?").bind(a.data.approval_id).first();
  assert.equal(sub.permalink, "https://www.reddit.com/r/admincraft/comments/aaa/x/ccc/");
  const sent = redditCalls.filter((c) => c.path === "/api/comment").at(-1);
  assert.equal(sent.body.thing_id, "t3_aaa"); assert.equal(sent.body.text, "Changed again.");
  assert.match(sent.ua, /^web:build\.osprey\.ads:v1\.0 \(by \/u\/osprey_admin\)$/);
  // replaying the same message never posts twice
  const again = await processApproval(env, env.DB, a.data.approval_id);
  assert.equal(again.outcome, "skipped");
});

test("hard blocks: cooldown, duplicate, cross-post, blacklist, flair, weekly-only, daily cap", async () => {
  // cooldown in admincraft
  const d1 = await call("POST", "/api/drafts", { kind: "reply", subreddit: "admincraft", thread_fullname: "t3_zzz", content: { body: "Another reply" } });
  let v = await viewHash(d1.data.id);
  assert.ok(v.blocks.some((b) => b.code === "cooldown"));
  assert.ok(v.blocks.some((b) => b.code === "sub_daily_cap"));
  // duplicate text to another sub (cross-post)
  await call("PUT", "/api/subreddits/mcservers", { ads_allowed: true, required_flair: true, cooldown_hours: 0, max_per_day: 2 });
  const d2 = await call("POST", "/api/drafts", { kind: "post", subreddit: "mcservers", content: { title: "Changed again.", body: "" } });
  v = await viewHash(d2.data.id);
  assert.ok(v.blocks.some((b) => b.code === "missing_flair"));
  assert.ok(v.blocks.some((b) => b.code === "cross_post"), "same text as the admincraft reply");
  const d3 = await call("POST", "/api/drafts", { kind: "post", subreddit: "mcservers", content: { title: "Osprey: finite island server", body: "Java + Bedrock.", flair_id: "abc-123" } });
  v = await viewHash(d3.data.id);
  assert.deepEqual(v.blocks, []);
  // weekly-only
  await call("PUT", "/api/subreddits/minecraft", { weekly_thread_only: true, weekly_thread_match: "Weekly Server Thread", comments_allowed: true });
  const d4 = await call("POST", "/api/drafts", { kind: "post", subreddit: "minecraft", content: { title: "Osprey", body: "x" } });
  assert.ok((await viewHash(d4.data.id)).blocks.some((b) => b.code === "weekly_only"));
  const d5 = await call("POST", "/api/drafts", { kind: "reply", subreddit: "minecraft", thread_fullname: "t3_wk1", thread_title: "Weekly Server Thread #42", content: { body: "Osprey!" } });
  assert.ok(!(await viewHash(d5.data.id)).blocks.some((b) => b.code === "weekly_only"));
  // blacklist
  await call("PUT", "/api/subreddits/minecraft", { blacklisted: true, weekly_thread_only: true, weekly_thread_match: "Weekly Server Thread" });
  assert.ok((await viewHash(d5.data.id)).blocks.some((b) => b.code === "blacklisted"));
  // pause via queue action
  await call("POST", "/api/subreddits/mcservers/pause");
  assert.ok((await viewHash(d3.data.id)).blocks.some((b) => b.code === "paused"));
  await call("POST", "/api/subreddits/mcservers/pause", { paused: false });
  // min-gap pacing: approving now is refused because the gap outlasts... no: gap 20m < ttl 30m -> allowed with delay
  v = await viewHash(d3.data.id);
  const a = await call("POST", `/api/drafts/${d3.data.id}/approve`, { content_hash: v.content_hash, version: v.version });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.ok(queued.at(-1).o?.delaySeconds > 0, "queued with spacing delay");
  const r = await processApproval(env, env.DB, a.data.approval_id);
  assert.equal(r.outcome, "deferred");
  // daily cap
  await call("PUT", "/api/settings", { daily_cap: 1 });
  assert.ok((await viewHash(d3.data.id)).blocks.some((b) => b.code === "daily_cap"));
  assert.equal((await processApproval(env, env.DB, a.data.approval_id)).outcome, "blocked");
  await call("PUT", "/api/settings", { daily_cap: 3 });
});

test("hand-off mode: approval required, hash checked, permalink recorded", async () => {
  await call("PUT", "/api/settings", { submit_mode: "handoff", min_gap_minutes: 0 });
  await call("PUT", "/api/subreddits/feedthebeast", { ads_allowed: true, cooldown_hours: 0, max_per_day: 1 });
  const d = await call("POST", "/api/drafts", { kind: "post", subreddit: "feedthebeast", content: { title: "Hand-off test", body: "Body" } });
  const v = await viewHash(d.data.id);
  const a = await call("POST", `/api/drafts/${d.data.id}/approve`, { content_hash: v.content_hash, version: v.version });
  assert.equal(a.data.mode, "handoff");
  const qn = queued.length;
  const done = await call("POST", `/api/approvals/${a.data.approval_id}/complete`, { permalink: "https://www.reddit.com/r/feedthebeast/comments/xyz/hand_off_test/" });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(queued.length, qn, "hand-off never touches the queue");
  const h = await call("GET", "/api/history");
  assert.ok(h.data.submissions.some((s) => s.mode === "handoff" && s.permalink.includes("xyz")));
  const au = await call("GET", "/api/audit");
  assert.ok(au.data.entries.some((e) => e.action === "approval.granted"));
  assert.ok(au.data.entries.some((e) => e.action === "submission.blocked"));
  const dash = await call("GET", "/api/dashboard");
  assert.equal(dash.status, 200);
  assert.ok(dash.data.cooldowns.length >= 3);
});
