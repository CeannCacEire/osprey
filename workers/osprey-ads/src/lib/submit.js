/* =========================================================================
   Submission worker core. Runs once per queue message ({ approval_id }).
   Order of checks — any failure means nothing is sent to Reddit:
     1. approval exists and is 'active'
     2. approval hasn't expired
     3. draft content still hashes to approvals.content_hash (and same version)
     4. every hard block is re-checked at submit time
     5. rate-limit budget / pacing gap  -> re-queue with a delay (not a failure)
     6. atomic claim: active -> processing (so a message can never post twice)
   ========================================================================= */
import { buildPayload, contentHash, textFingerprint } from "../../../../ads/assets/content.js";
import { evaluate } from "./policy.js";
import { sendPayload, assertRateBudget, RateLimitError, getRateState } from "./reddit.js";
import { now, getSettings, audit, loadDraft } from "./util.js";

async function recordBlocked(db, approval, draft, reason, approvalStatus) {
  const t = now();
  await db.batch([
    db.prepare("UPDATE approvals SET status = ?, status_reason = ?, consumed_at = ? WHERE id = ? AND status IN ('active','processing')")
      .bind(approvalStatus, reason, t, approval.id),
    db.prepare("UPDATE drafts SET status = 'failed', reject_reason = ?, updated_at = ? WHERE id = ? AND status IN ('queued','submitting','handoff')")
      .bind(reason, t, draft.id),
    db.prepare(`INSERT OR IGNORE INTO submissions (draft_id, approval_id, kind, subreddit, content_hash, text_fingerprint, status, error, mode, created_at)
      VALUES (?,?,?,?,?,?, 'blocked', ?, ?, ?)`)
      .bind(draft.id, approval.id, draft.kind, draft.subreddit, approval.content_hash, draft.text_fingerprint, reason, approval.mode, t),
  ]);
  await audit(db, "submitter", "submission.blocked", "approval", approval.id, { draft_id: draft.id, reason });
  return { done: true, outcome: "blocked", reason };
}

/** Shared verification for API submission and manual hand-off completion. */
export async function verifyApproval(env, db, approvalId, { phase }) {
  const approval = await db.prepare("SELECT * FROM approvals WHERE id = ?").bind(approvalId).first();
  if (!approval) return { fail: "Approval not found." };
  if (approval.status !== "active") return { fail: `Approval is ${approval.status}, not active.`, approval, silent: true };
  const draft = await loadDraft(db, approval.draft_id);
  if (!draft) return { fail: "Draft no longer exists.", approval };
  if (now() > approval.expires_at) return { fail: "Approval expired before it was submitted. Re-approve to try again.", approval, draft, status: "expired" };
  const hash = await contentHash(draft);
  if (hash !== approval.content_hash || draft.content_hash !== approval.content_hash || draft.version !== approval.draft_version)
    return { fail: "Content changed after approval. Review and approve the new version.", approval, draft, status: "revoked" };
  draft.text_fingerprint = await textFingerprint(draft);
  const settings = await getSettings(db);
  const connected = approval.mode === "api" ? Boolean(await db.prepare("SELECT 1 AS x FROM reddit_accounts WHERE id = 1").first()) : true;
  const policy = await evaluate(db, draft, { settings, phase, mode: approval.mode, redditConnected: connected });
  if (policy.blocks.length) return { fail: "Blocked at submit time: " + policy.blocks.map((b) => b.message).join(" "), approval, draft, status: "rejected" };
  return { approval, draft, settings, policy };
}

export async function processApproval(env, db, approvalId) {
  const v = await verifyApproval(env, db, approvalId, { phase: "submit" });
  if (v.fail) {
    if (v.silent || !v.draft) { await audit(db, "submitter", "submission.skipped", "approval", approvalId, { reason: v.fail }); return { done: true, outcome: "skipped", reason: v.fail }; }
    return recordBlocked(db, v.approval, v.draft, v.fail, v.status || "rejected");
  }
  const { approval, draft, policy } = v;
  if (approval.mode !== "api") return { done: true, outcome: "skipped", reason: "hand-off approvals are completed by the admin" };

  // Pacing: wait out the minimum gap / rate-limit window, as long as the approval is still valid then.
  try { await assertRateBudget(db, 0); } catch (e) {
    if (e instanceof RateLimitError) return requeue(db, approval, e.resetAt, "rate limit window");
    throw e;
  }
  const gap = policy.waits.find((w) => w.code === "min_gap");
  if (gap) return requeue(db, approval, gap.until, "minimum gap between submissions");

  // Atomic claim — only one consumer can move active -> processing.
  const claim = await db.prepare("UPDATE approvals SET status = 'processing' WHERE id = ? AND status = 'active'").bind(approval.id).run();
  if (!claim.meta.changes) return { done: true, outcome: "skipped", reason: "already claimed" };
  await db.prepare("UPDATE drafts SET status = 'submitting', updated_at = ? WHERE id = ?").bind(now(), draft.id).run();

  const payload = buildPayload(draft);
  try {
    const r = await sendPayload(env, db, payload);
    const rate = await getRateState(db);
    const t = now();
    await db.batch([
      db.prepare("UPDATE approvals SET status = 'consumed', consumed_at = ? WHERE id = ?").bind(t, approval.id),
      db.prepare("UPDATE drafts SET status = 'submitted', reject_reason = NULL, updated_at = ? WHERE id = ?").bind(t, draft.id),
      db.prepare(`INSERT INTO submissions (draft_id, approval_id, kind, subreddit, content_hash, text_fingerprint, status, reddit_fullname, permalink, ratelimit_remaining, ratelimit_reset, mode, created_at)
        VALUES (?,?,?,?,?,?, 'submitted', ?,?,?,?, 'api', ?)`)
        .bind(draft.id, approval.id, draft.kind, draft.subreddit, approval.content_hash, draft.text_fingerprint, r.fullname, r.permalink, rate.remaining ?? null, rate.reset_at ?? null, t),
    ]);
    if (draft.candidate_id) await db.prepare("UPDATE candidate_opportunities SET status = 'drafted' WHERE id = ?").bind(draft.candidate_id).run();
    await audit(db, "submitter", "submission.sent", "draft", draft.id, { approval_id: approval.id, permalink: r.permalink, fullname: r.fullname });
    return { done: true, outcome: "submitted", permalink: r.permalink };
  } catch (e) {
    // A 429 (or Reddit's RATELIMIT error) means nothing was posted: release the claim and retry later.
    if (e instanceof RateLimitError || e.ratelimited) {
      const until = e instanceof RateLimitError ? e.resetAt : now() + 10 * 60_000;
      await db.prepare("UPDATE approvals SET status = 'active' WHERE id = ? AND status = 'processing'").bind(approval.id).run();
      await db.prepare("UPDATE drafts SET status = 'queued', updated_at = ? WHERE id = ?").bind(now(), draft.id).run();
      return requeue(db, approval, until, "Reddit rate limit");
    }
    // Anything else could be ambiguous (e.g. a 5xx after Reddit accepted it), so never retry automatically.
    const t = now();
    const msg = String(e.message || e).slice(0, 500);
    await db.batch([
      db.prepare("UPDATE approvals SET status = 'consumed', consumed_at = ?, status_reason = ? WHERE id = ?").bind(t, "failed: " + msg, approval.id),
      db.prepare("UPDATE drafts SET status = 'failed', reject_reason = ?, updated_at = ? WHERE id = ?").bind(msg, t, draft.id),
      db.prepare(`INSERT INTO submissions (draft_id, approval_id, kind, subreddit, content_hash, text_fingerprint, status, error, mode, created_at)
        VALUES (?,?,?,?,?,?, 'failed', ?, 'api', ?)`)
        .bind(draft.id, approval.id, draft.kind, draft.subreddit, approval.content_hash, draft.text_fingerprint, msg, t),
    ]);
    await audit(db, "submitter", "submission.failed", "draft", draft.id, { approval_id: approval.id, error: msg });
    return { done: true, outcome: "failed", error: msg };
  }
}

async function requeue(db, approval, until, why) {
  if (until >= approval.expires_at) {
    const draft = await loadDraft(db, approval.draft_id);
    draft.text_fingerprint = draft.text_fingerprint || (await textFingerprint(draft));
    return recordBlocked(db, approval, draft, `Approval would expire while waiting for the ${why}. Re-approve later.`, "expired");
  }
  const delaySeconds = Math.max(5, Math.ceil((until - now()) / 1000) + 2);
  await audit(db, "submitter", "submission.deferred", "approval", approval.id, { why, delaySeconds });
  return { done: false, outcome: "deferred", delaySeconds };
}
