/* =========================================================================
   Osprey /ads — shared content model
   -------------------------------------------------------------------------
   Imported by BOTH the browser pages and the Cloudflare Workers, so the
   preview, the approval hash and the request sent to Reddit are all built
   from the same function. Keep it free of DOM and Worker-only APIs.
   ========================================================================= */

export const LIMITS = Object.freeze({
  TITLE_MAX: 300,          // Reddit post title limit
  POST_BODY_MAX: 40000,    // self-post body limit
  COMMENT_MAX: 10000,      // comment body limit
});

export const POST_TYPES = Object.freeze(["text", "link", "image"]);

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Normalise a subreddit name: strip r/ and slashes, lower-case. */
export function normSub(name) {
  return str(name).trim().replace(/^\/?r\//i, "").replace(/\/+$/, "").toLowerCase();
}

/** Clean the editable fields of a draft (content_json). */
export function normalizeContent(c = {}) {
  const post_type = POST_TYPES.includes(c.post_type) ? c.post_type : "text";
  return {
    post_type,
    title: str(c.title).replace(/\s+/g, " ").trim(),
    body: str(c.body).replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim(),
    cta: str(c.cta).replace(/\r\n?/g, "\n").trim(),
    image_url: str(c.image_url).trim(),
    link_url: str(c.link_url).trim(),
    flair_id: str(c.flair_id).trim(),
    flair_text: str(c.flair_text).trim(),
  };
}

function joinBlocks(...parts) {
  return parts.map((p) => str(p).trim()).filter(Boolean).join("\n\n");
}

/**
 * Build the exact request payload that will be sent to Reddit.
 * The approval hash is computed over this object, so anything that changes
 * what Reddit receives also changes the hash.
 *   post/text  -> POST /api/submit  kind=self  (body + CTA + image link)
 *   post/link  -> POST /api/submit  kind=link  url=link_url
 *   post/image -> POST /api/submit  kind=link  url=image_url (hosted image)
 *   reply      -> POST /api/comment thing_id=t3_…  (body + CTA + image link)
 */
export function buildPayload(draft) {
  const c = normalizeContent(draft.content || {});
  const sr = normSub(draft.subreddit);
  if (draft.kind === "reply") {
    return {
      endpoint: "/api/comment",
      thing_id: str(draft.thread_fullname).trim(),
      text: joinBlocks(c.body, c.cta, c.image_url),
    };
  }
  const base = { endpoint: "/api/submit", sr, title: c.title, flair_id: c.flair_id, flair_text: c.flair_text };
  if (c.post_type === "link") return { ...base, kind: "link", url: c.link_url };
  if (c.post_type === "image") return { ...base, kind: "link", url: c.image_url };
  return { ...base, kind: "self", text: joinBlocks(c.body, c.cta, c.image_url) };
}

/** Deterministic JSON: sorted keys, no whitespace. */
export function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalJSON(value[k])).join(",") + "}";
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash bound to target + exact payload. This is what an approval signs off. */
export async function contentHash(draft) {
  const payload = buildPayload(draft);
  return sha256Hex(canonicalJSON({ v: 1, kind: draft.kind, subreddit: normSub(draft.subreddit), payload }));
}

/** Loose text fingerprint (case/whitespace/punctuation-insensitive) for duplicate detection. */
export async function textFingerprint(draft) {
  const p = buildPayload(draft);
  const text = [p.title, p.text, p.url].filter(Boolean).join(" ")
    .toLowerCase().replace(/https?:\/\/\S+/g, (u) => u.replace(/[?#].*$/, ""))
    .replace(/[^\p{L}\p{N}:/.]+/gu, " ").replace(/\s+/g, " ").trim();
  return sha256Hex(text);
}

/** Field validation. Returns a list of { field, message }. */
export function validateDraft(draft) {
  const errs = [];
  const c = normalizeContent(draft.content || {});
  const p = buildPayload(draft);
  if (!["post", "reply"].includes(draft.kind)) errs.push({ field: "kind", message: "Choose post or reply." });
  if (!/^[a-z0-9_]{2,21}$/.test(normSub(draft.subreddit))) errs.push({ field: "subreddit", message: "Enter a valid subreddit name." });
  const isUrl = (u) => { try { return ["https:", "http:"].includes(new URL(u).protocol); } catch { return false; } };
  if (draft.kind === "reply") {
    if (!/^t3_[a-z0-9]+$/i.test(str(draft.thread_fullname))) errs.push({ field: "thread", message: "Pick the Reddit thread to reply to." });
    if (!p.text) errs.push({ field: "body", message: "A reply needs some text." });
    if (p.text.length > LIMITS.COMMENT_MAX) errs.push({ field: "body", message: `Replies are limited to ${LIMITS.COMMENT_MAX} characters.` });
  } else {
    if (!c.title) errs.push({ field: "title", message: "A post needs a title." });
    if (c.title.length > LIMITS.TITLE_MAX) errs.push({ field: "title", message: `Titles are limited to ${LIMITS.TITLE_MAX} characters.` });
    if (c.post_type === "text" && !p.text) errs.push({ field: "body", message: "A text post needs a body." });
    if (p.text && p.text.length > LIMITS.POST_BODY_MAX) errs.push({ field: "body", message: `Post bodies are limited to ${LIMITS.POST_BODY_MAX} characters.` });
    if (c.post_type === "link" && !isUrl(c.link_url)) errs.push({ field: "link_url", message: "Link posts need a valid URL." });
    if (c.post_type === "image" && !isUrl(c.image_url)) errs.push({ field: "image_url", message: "Image posts need the URL of a hosted image." });
  }
  if (c.image_url && !isUrl(c.image_url)) errs.push({ field: "image_url", message: "The image URL isn't valid." });
  return errs;
}

/** Fill {{placeholders}} in template text. Unknown placeholders are left as-is. */
export function fillTemplate(text, vars = {}) {
  return str(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k in vars ? str(vars[k]) : m));
}

/** Parse a Reddit thread URL or id into { fullname, subreddit }. */
export function parseThreadRef(input) {
  const s = str(input).trim();
  let m = s.match(/^t3_([a-z0-9]+)$/i);
  if (m) return { fullname: "t3_" + m[1].toLowerCase(), subreddit: "" };
  m = s.match(/reddit\.com\/r\/([a-z0-9_]+)\/comments\/([a-z0-9]+)/i);
  if (m) return { fullname: "t3_" + m[2].toLowerCase(), subreddit: m[1].toLowerCase() };
  m = s.match(/redd\.it\/([a-z0-9]+)/i);
  if (m) return { fullname: "t3_" + m[1].toLowerCase(), subreddit: "" };
  return null;
}
