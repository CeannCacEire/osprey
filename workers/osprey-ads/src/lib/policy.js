/* =========================================================================
   Hard blocks. Checked when a draft is shown in the queue, again when it
   is approved, and again by the submitter right before calling Reddit.
   Any block = no submission. Subreddits with no rule are blocked by default.
   ========================================================================= */
import { normSub, validateDraft } from "../../../../ads/assets/content.js";
import { now, HOUR, DAY } from "./util.js";

const fmtWait = (ms) => {
  const h = Math.floor(ms / HOUR), m = Math.ceil((ms % HOUR) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
};

/**
 * @param draft  draft row with .content, .content_hash, .text_fingerprint
 * @param ctx    { settings, rule?, phase: 'review'|'approve'|'submit', mode, redditConnected }
 * @returns { blocks: [{code, message}], waits: [{code, message, until}] }
 *   waits are pacing delays (min gap between submissions). The submitter
 *   re-queues for those instead of failing; approval is still allowed.
 */
export async function evaluate(db, draft, ctx) {
  const blocks = [], waits = [];
  const add = (code, message) => blocks.push({ code, message });
  const s = ctx.settings;
  const sub = normSub(draft.subreddit);
  const t = now();

  for (const e of validateDraft(draft)) add("invalid_" + e.field, e.message);
  if (s.kill_switch) add("kill_switch", "Submissions are switched off (kill switch on the dashboard).");

  const rule = ctx.rule !== undefined ? ctx.rule
    : await db.prepare("SELECT * FROM subreddit_rules WHERE subreddit = ?").bind(sub).first();
  if (!rule) {
    add("no_rule", `r/${sub} has no rules yet. Add it on the Subreddits page before posting there.`);
    return { blocks, waits, rule: null };
  }
  if (rule.blacklisted) add("blacklisted", `r/${sub} is blacklisted.`);
  if (rule.paused) add("paused", `r/${sub} is paused.`);

  if (draft.kind === "post") {
    if (rule.weekly_thread_only) add("weekly_only", `r/${sub} only allows promotion in its weekly thread. Make this a reply to that thread.`);
    else if (!rule.ads_allowed) add("ads_not_allowed", `Promotional posts aren't allowed in r/${sub}.`);
    if (rule.required_flair && !(draft.content?.flair_id || "").trim()) add("missing_flair", `r/${sub} requires post flair. Set a flair ID.`);
  } else {
    const inWeekly = rule.weekly_thread_only && rule.weekly_thread_match &&
      (draft.thread_title || "").toLowerCase().includes(rule.weekly_thread_match.toLowerCase());
    if (rule.weekly_thread_only && !inWeekly)
      add("weekly_only", `r/${sub} only allows promotion in its weekly thread${rule.weekly_thread_match ? ` (title containing “${rule.weekly_thread_match}”)` : ""}.`);
    else if (!rule.weekly_thread_only && !rule.comments_allowed) add("comments_not_allowed", `Promotional replies aren't allowed in r/${sub}.`);
  }

  const ok = "status = 'submitted'";
  // Per-subreddit cooldown
  const last = await db.prepare(`SELECT MAX(created_at) AS at FROM submissions WHERE subreddit = ? AND ${ok}`).bind(sub).first();
  if (last?.at && rule.cooldown_hours > 0) {
    const until = last.at + rule.cooldown_hours * HOUR;
    if (until > t) add("cooldown", `r/${sub} is cooling down for another ${fmtWait(until - t)}.`);
  }
  // Per-subreddit daily maximum (rolling 24h)
  const subDay = await db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE subreddit = ? AND ${ok} AND created_at > ?`).bind(sub, t - DAY).first();
  if (rule.max_per_day > 0 && subDay.n >= rule.max_per_day) add("sub_daily_cap", `r/${sub} has reached its limit of ${rule.max_per_day} per 24 hours.`);
  // Global daily cap (rolling 24h)
  const day = await db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE ${ok} AND created_at > ?`).bind(t - DAY).first();
  if (day.n >= s.daily_cap) add("daily_cap", `The daily cap of ${s.daily_cap} submissions has been reached.`);

  // Duplicate content
  const dupSame = await db.prepare(`SELECT id FROM submissions WHERE text_fingerprint = ? AND subreddit = ? AND ${ok} LIMIT 1`).bind(draft.text_fingerprint, sub).first();
  if (dupSame) add("duplicate", `This text has already been submitted to r/${sub}.`);
  const dupOther = await db.prepare(`SELECT subreddit FROM submissions WHERE text_fingerprint = ? AND subreddit != ? AND ${ok} AND created_at > ? LIMIT 1`)
    .bind(draft.text_fingerprint, sub, t - s.duplicate_window_days * DAY).first();
  if (dupOther) add("cross_post", `The same text went to r/${dupOther.subreddit} in the last ${s.duplicate_window_days} days. Rewrite it for this community.`);
  const dupQueued = await db.prepare("SELECT id FROM drafts WHERE text_fingerprint = ? AND id != ? AND status IN ('queued','submitting','handoff') LIMIT 1")
    .bind(draft.text_fingerprint, draft.id ?? -1).first();
  if (dupQueued) add("duplicate_queued", `Draft #${dupQueued.id} with the same text is already approved and waiting.`);
  if (draft.kind === "reply" && draft.thread_fullname) {
    const replied = await db.prepare(`SELECT d.id FROM submissions s JOIN drafts d ON d.id = s.draft_id WHERE d.thread_fullname = ? AND s.${ok} LIMIT 1`)
      .bind(draft.thread_fullname).first();
    if (replied) add("already_replied", "You've already replied to this thread.");
  }

  if (ctx.mode === "api" && ctx.phase !== "review" && !ctx.redditConnected) add("not_connected", "Reddit isn't connected. Connect it on the dashboard, or switch to manual hand-off.");

  // Pacing (not a hard block): minimum gap between any two submissions.
  const lastAny = await db.prepare(`SELECT MAX(created_at) AS at FROM submissions WHERE ${ok}`).first();
  if (lastAny?.at && s.min_gap_minutes > 0) {
    const until = lastAny.at + s.min_gap_minutes * 60_000;
    if (until > t) waits.push({ code: "min_gap", message: `Spacing: next submission allowed in ${fmtWait(until - t)}.`, until });
  }
  return { blocks, waits, rule };
}
