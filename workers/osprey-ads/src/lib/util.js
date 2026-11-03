export const now = () => Date.now();
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export function randomId(bytes = 18) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const b64 = {
  enc: (u8) => btoa(String.fromCharCode(...u8)),
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

export function parseJSON(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

export async function getSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return {
    daily_cap: Number(s.daily_cap ?? 3),
    min_gap_minutes: Number(s.min_gap_minutes ?? 20),
    approval_ttl_minutes: Number(s.approval_ttl_minutes ?? 30),
    duplicate_window_days: Number(s.duplicate_window_days ?? 30),
    submit_mode: s.submit_mode === "handoff" ? "handoff" : "api",
    kill_switch: s.kill_switch === "1",
  };
}

/** Append-only audit trail. Never throws (an audit failure must not hide the real result). */
export async function audit(db, actor, action, entityType, entityId, detail) {
  try {
    await db.prepare("INSERT INTO audit_log (at, actor, action, entity_type, entity_id, detail_json) VALUES (?,?,?,?,?,?)")
      .bind(now(), actor, action, entityType ?? null, entityId == null ? null : String(entityId), detail ? JSON.stringify(detail) : null).run();
  } catch (e) { console.error("audit failed", e); }
}

/** Load a draft row and decode content_json into .content */
export async function loadDraft(db, id) {
  const row = await db.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first();
  if (!row) return null;
  return { ...row, content: parseJSON(row.content_json, {}) };
}
