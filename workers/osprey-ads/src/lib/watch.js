/* =========================================================================
   Watcher core. Reads /new for subreddits you added, matches keywords and
   stores candidate opportunities (optionally with a *suggested* draft).
   It never approves, queues or submits anything.
   ========================================================================= */
import { contentHash, textFingerprint, fillTemplate, normSub } from "../../../../ads/assets/content.js";
import { listNew, RateLimitError } from "./reddit.js";
import { now, HOUR, DAY, parseJSON, audit } from "./util.js";

export const DEFAULT_KEYWORDS = [
  "looking for a server", "looking for server", "looking for an smp", "looking for a smp", "looking for smp",
  "server recommendations", "server recommendation", "recommend a server", "recommend me a server",
  "any good servers", "good server to join", "new server to join", "survival server", "civilization server",
  "civilisation server", "nations server", "crossplay server", "java and bedrock server",
];

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ");

export function matchPost(post, keywords, excludes) {
  const hay = norm(post.title + " " + (post.selftext || ""));
  if (excludes.some((x) => x && hay.includes(norm(x)))) return [];
  return keywords.filter((k) => k && hay.includes(norm(k)));
}

export async function scanWatcher(env, db, w, actor = "watcher") {
  const rule = await db.prepare("SELECT * FROM subreddit_rules WHERE subreddit = ?").bind(w.subreddit).first();
  if (!rule || rule.blacklisted || rule.paused) {
    await db.prepare("UPDATE watchers SET last_scanned_at = ?, last_error = ? WHERE id = ?")
      .bind(now(), !rule ? "No subreddit rule" : rule.blacklisted ? "Subreddit is blacklisted" : "Subreddit is paused", w.id).run();
    return { found: 0, skipped: true };
  }
  const keywords = parseJSON(w.keywords_json, DEFAULT_KEYWORDS);
  const excludes = parseJSON(w.exclude_json, []);
  const me = (await db.prepare("SELECT username FROM reddit_accounts WHERE id = 1").first())?.username?.toLowerCase();
  let posts;
  try { posts = await listNew(env, db, w.subreddit, 50); }
  catch (e) {
    await db.prepare("UPDATE watchers SET last_error = ? WHERE id = ?").bind(String(e.message || e).slice(0, 300), w.id).run();
    if (e instanceof RateLimitError) throw e;
    return { found: 0, error: e.message };
  }
  const tpl = w.template_id ? await db.prepare("SELECT * FROM templates WHERE id = ? AND archived = 0").bind(w.template_id).first() : null;
  const cutoff = now() - w.max_age_hours * HOUR;
  let found = 0;
  for (const p of posts) {
    const created = Math.round((p.created_utc || 0) * 1000);
    if (created < cutoff || p.locked || p.archived || p.removed_by_category || p.stickied) continue;
    if (me && String(p.author || "").toLowerCase() === me) continue;
    const hits = matchPost(p, keywords, excludes);
    if (!hits.length) continue;
    const ins = await db.prepare(`INSERT OR IGNORE INTO candidate_opportunities
        (watcher_id, subreddit, reddit_fullname, title, excerpt, author, permalink, matched_keywords, score, reddit_created_at, status, source, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'new', 'watcher', ?)`)
      .bind(w.id, normSub(p.subreddit || w.subreddit), p.name, String(p.title).slice(0, 300), String(p.selftext || "").slice(0, 600),
        p.author || null, "https://www.reddit.com" + p.permalink, JSON.stringify(hits), hits.length, created, now()).run();
    if (!ins.meta.changes) continue;
    found++;
    const candId = ins.meta.last_row_id;
    if (tpl && tpl.kind === "reply") await suggestDraft(db, tpl, { id: candId, subreddit: normSub(p.subreddit || w.subreddit), fullname: p.name, title: p.title, permalink: "https://www.reddit.com" + p.permalink, author: p.author });
  }
  await db.prepare("UPDATE watchers SET last_scanned_at = ?, last_error = NULL WHERE id = ?").bind(now(), w.id).run();
  await audit(db, actor, "watcher.scanned", "watcher", w.id, { subreddit: w.subreddit, checked: posts.length, new_candidates: found });
  return { found, checked: posts.length };
}

/** Create a 'suggested' reply draft from a template for a candidate. Still needs review + approval. */
export async function suggestDraft(db, tpl, cand, createdBy = null, status = "suggested") {
  const c = parseJSON(tpl.content_json, {});
  const vars = { subreddit: cand.subreddit, author: cand.author || "", thread_title: cand.title || "" };
  const content = { ...c, body: fillTemplate(c.body, vars), cta: fillTemplate(c.cta, vars), title: "" };
  const draft = { kind: "reply", subreddit: cand.subreddit, thread_fullname: cand.fullname, content };
  const t = now();
  const r = await db.prepare(`INSERT INTO drafts (kind, subreddit, thread_fullname, thread_title, thread_permalink, content_json, content_hash, text_fingerprint, status, template_id, candidate_id, created_by, created_at, updated_at)
      VALUES ('reply',?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(cand.subreddit, cand.fullname, cand.title, cand.permalink, JSON.stringify(content), await contentHash(draft), await textFingerprint(draft),
      status, tpl.id, cand.id, createdBy, t, t).run();
  await db.prepare("UPDATE candidate_opportunities SET status = 'drafted' WHERE id = ?").bind(cand.id).run();
  return r.meta.last_row_id;
}

export async function runDueWatchers(env, db, maxPerRun = 5) {
  const t = now();
  await db.prepare("UPDATE candidate_opportunities SET status = 'expired' WHERE status = 'new' AND created_at < ?").bind(t - 7 * DAY).run();
  await db.prepare("UPDATE approvals SET status = 'expired', status_reason = 'expired unsubmitted' WHERE status = 'active' AND mode = 'handoff' AND expires_at < ?").bind(t).run();
  if (!(await db.prepare("SELECT 1 AS x FROM reddit_accounts WHERE id = 1").first())) return { ran: 0, reason: "Reddit not connected" };
  const { results } = await db.prepare(
    `SELECT * FROM watchers WHERE enabled = 1 AND (last_scanned_at IS NULL OR last_scanned_at + interval_minutes * 60000 <= ?) ORDER BY last_scanned_at ASC NULLS FIRST LIMIT ?`
  ).bind(t, maxPerRun).all();
  let ran = 0;
  for (const w of results) {
    try { await scanWatcher(env, db, w); ran++; }
    catch (e) { if (e instanceof RateLimitError) break; console.error("watcher", w.id, e); }
  }
  return { ran };
}
