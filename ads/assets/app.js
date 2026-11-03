/* =========================================================================
   Osprey /ads — shared client
   Auth gate, API client, layout shell, DOM helpers and the Reddit preview.
   All server data is rendered with textContent / DOM nodes, never innerHTML.
   ========================================================================= */
import { API_BASE } from "./config.js";
import { buildPayload, contentHash } from "./content.js";

const TOKEN_KEY = "osprey-ads-session";
export const session = {
  get token() { return sessionStorage.getItem(TOKEN_KEY); },
  set(t) { sessionStorage.setItem(TOKEN_KEY, t); },
  clear() { sessionStorage.removeItem(TOKEN_KEY); },
};

/* ---------- DOM helper ---------- */
// Let conditional children be written as `cond ? node : null` everywhere.
for (const m of ["append", "replaceChildren", "prepend"]) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "value") { value = v; continue; }
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  if (value !== undefined) el.value = value;
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);

/* ---------- API ---------- */
export class ApiError extends Error { constructor(status, data) { super(data?.error || `Request failed (${status})`); this.status = status; this.data = data; } }
export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session.token ? { Authorization: "Bearer " + session.token } : {}) },
      body: body ? JSON.stringify(body) : undefined, credentials: "omit",
    });
  } catch { throw new ApiError(0, { error: "Can't reach the outreach API. Check that the osprey-ads-api Worker is deployed." }); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/login")) { session.clear(); renderGate(); throw new ApiError(401, data); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* ---------- feedback ---------- */
export function toast(msg, kind = "ok") {
  let box = $(".toasts");
  if (!box) { box = h("div", { class: "toasts", role: "status", "aria-live": "polite" }); document.body.append(box); }
  const t = h("div", { class: "toast" + (kind === "error" ? " toast--error" : ""), text: msg });
  box.append(t); setTimeout(() => t.remove(), kind === "error" ? 8000 : 4000);
}
export const fail = (e) => toast(e.message || String(e), "error");

/** In-page dialog (native confirm/prompt can be suppressed). Resolves to the input value, true, or null. */
export function ask({ title, message, confirmLabel = "Confirm", danger = false, input = null, details = null }) {
  return new Promise((resolve) => {
    const field = input ? h(input.multiline ? "textarea" : "input", { value: input.value || "", placeholder: input.placeholder || "", rows: 3 }) : null;
    const dlg = h("dialog", {},
      h("form", { method: "dialog", class: "stack" },
        h("h2", { text: title }),
        message ? h("p", { class: "muted", text: message }) : null,
        details,
        field ? h("label", {}, input.label || "", field) : null,
        h("div", { class: "row row--end" },
          h("button", { class: "btn btn--ghost", value: "cancel", type: "submit", text: "Cancel" }),
          h("button", { class: "btn " + (danger ? "btn--danger" : "btn--primary"), value: "ok", type: "submit", text: confirmLabel }))));
    dlg.addEventListener("close", () => { const ok = dlg.returnValue === "ok"; dlg.remove(); resolve(ok ? (field ? field.value : true) : null); });
    document.body.append(dlg); dlg.showModal(); (field || dlg.querySelector("[value=ok]")).focus();
  });
}

/* ---------- formatting ---------- */
const rtf = new Intl.RelativeTimeFormat("en-IE", { numeric: "auto" });
export function ago(ms) {
  if (!ms) return "never";
  const d = (ms - Date.now()) / 1000, a = Math.abs(d);
  if (a < 60) return rtf.format(Math.round(d), "second");
  if (a < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(d / 3600), "hour");
  return rtf.format(Math.round(d / 86400), "day");
}
export const when = (ms) => (ms ? new Date(ms).toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short" }) : "—");
export const chip = (text, tone = "") => h("span", { class: "chip" + (tone ? " chip--" + tone : ""), text });
export const STATUS_TONE = { suggested: "lav", draft: "", queued: "teal", submitting: "teal", handoff: "teal", submitted: "green", failed: "red", rejected: "red", blocked: "red", new: "lav", dismissed: "", expired: "" };
export const statusChip = (s) => chip(s, STATUS_TONE[s] || "");
export function externalLink(href, text) {
  try { const u = new URL(href); if (!["https:", "http:"].includes(u.protocol)) throw 0; return h("a", { href: u.href, target: "_blank", rel: "noopener noreferrer", text: text || u.href }); }
  catch { return h("span", { text: text || href || "" }); }
}

/* ---------- Reddit-style preview (safe mini-markdown) ---------- */
function inline(text) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])|(\bu\/[A-Za-z0-9_-]+|\br\/[A-Za-z0-9_]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h("strong", { text: m[2] }));
    else if (m[3]) out.push(externalLink(m[5], m[4]));
    else if (m[6]) out.push(externalLink(m[6]));
    else out.push(h("a", { href: "https://www.reddit.com/" + m[7], target: "_blank", rel: "noopener noreferrer", text: m[7] }));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function markdown(text) {
  const wrap = h("div", { class: "rd__body" });
  for (const block of String(text || "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) wrap.append(h("ul", {}, lines.map((l) => h("li", {}, inline(l.replace(/^\s*[-*]\s+/, ""))))));
    else { const p = h("p"); lines.forEach((l, i) => { if (i) p.append(h("br")); p.append(...inline(l)); }); wrap.append(p); }
  }
  return wrap;
}
const isImg = (u) => /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(u || "");

/** Render exactly what will be sent, from the same buildPayload() the Worker uses. */
export function redditPreview(draft, { username = "you" } = {}) {
  const p = buildPayload(draft);
  const sub = p.sr || draft.subreddit || "subreddit";
  const meta = (who) => h("div", { class: "rd__meta" }, who === "sub" ? h("span", { class: "rd__avatar", text: "r/" }) : null,
    who === "sub" ? h("span", { class: "rd__sub", text: "r/" + (sub || "…") }) : h("span", { class: "rd__sub", text: "u/" + username }),
    h("span", { text: "·" }), h("span", { text: "just now" }), who === "sub" ? h("span", { text: "· u/" + username }) : null);
  if (draft.kind === "reply") {
    return h("article", { class: "rd", "aria-label": "Reddit reply preview" },
      h("div", { class: "rd__parent" }, h("div", { class: "rd__meta" }, h("span", { class: "rd__sub", text: "r/" + (draft.subreddit || "…") }), h("span", { text: "· thread" })),
        h("div", { class: "rd__title", text: draft.thread_title || draft.thread_fullname || "Pick a thread to reply to" })),
      h("div", { class: "rd__comment" }, h("span", { class: "rd__avatar", text: "u/" }),
        h("div", {}, meta("user"), p.text ? markdown(p.text) : h("p", { class: "rd__empty", text: "Your reply will appear here." }),
          h("div", { class: "rd__bar" }, h("span", { class: "rd__pill", text: "▲ 1 ▼" }), h("span", { class: "rd__pill", text: "Reply" })))));
  }
  const flair = draft.content?.flair_text || (draft.content?.flair_id ? "flair " + draft.content.flair_id.slice(0, 8) : "");
  return h("article", { class: "rd", "aria-label": "Reddit post preview" },
    meta("sub"),
    h("div", { class: "rd__title", text: p.title || "Your title" }),
    flair ? h("span", { class: "rd__flair", text: flair }) : null,
    p.kind === "link" && p.url ? (isImg(p.url) ? h("img", { class: "rd__img", src: p.url, alt: "Image post preview" }) : h("div", { class: "rd__link", text: "↗ " + p.url })) : null,
    p.kind === "self" ? (p.text ? markdown(p.text) : h("p", { class: "rd__empty", text: "Body text appears here." })) : null,
    p.kind === "self" && draft.content?.image_url && isImg(draft.content.image_url) ? h("img", { class: "rd__img", src: draft.content.image_url, alt: "Linked image" }) : null,
    h("div", { class: "rd__bar" }, h("span", { class: "rd__pill", text: "▲ 1 ▼" }), h("span", { class: "rd__pill", text: "0 comments" }), h("span", { class: "rd__pill", text: "Share" })));
}
export { buildPayload, contentHash };

/* ---------- shell ---------- */
const NAV = [
  ["dashboard", "/ads/", "Dashboard"], ["queue", "/ads/queue/", "Approval queue"], ["builder", "/ads/drafts/new/", "New draft"],
  ["templates", "/ads/templates/", "Templates"], ["subreddits", "/ads/subreddits/", "Subreddits"], ["history", "/ads/history/", "History"],
];
let me = null;
function shell(page) {
  const main = h("main", { id: "main", class: "main", tabindex: "-1" });
  const nav = h("nav", { class: "nav", "aria-label": "Outreach" },
    NAV.map(([id, href, label]) => h("a", { href, "aria-current": id === page ? "page" : null }, label, id === "queue" ? h("span", { class: "count", id: "queue-count", hidden: true }) : null)));
  const side = h("aside", { class: "side" },
    h("a", { class: "side__brand", href: "/ads/" }, h("span", { class: "wordmark", text: "Osprey" }), h("span", { class: "side__tag", text: "Outreach" })),
    nav,
    h("div", { class: "side__foot" }, h("span", { text: "Signed in as " + (me?.username || "…") }),
      h("span", { text: "Nothing posts without your approval." }),
      h("button", { class: "btn btn--sm btn--ghost", text: "Sign out", onclick: async () => { try { await api("/api/logout", { method: "POST" }); } catch {} session.clear(); renderGate(); } })));
  document.body.replaceChildren(h("a", { class: "skip-link", href: "#main", text: "Skip to content" }), h("div", { class: "shell" }, side, main));
  api("/api/drafts?status=suggested,draft").then((r) => { const c = $("#queue-count"); if (c && r.drafts.length) { c.textContent = r.drafts.length; c.hidden = false; } }).catch(() => {});
  return main;
}

let pageRender = null, pageId = null;
function renderGate(mode = "login") {
  const err = h("p", { class: "field-error", role: "alert" });
  const user = h("input", { autocomplete: "username", required: true, name: "username" });
  const pass = h("input", { type: "password", autocomplete: mode === "login" ? "current-password" : "new-password", required: true, minlength: mode === "login" ? null : 12, name: "password" });
  const setup = h("input", { type: "password", autocomplete: "off", required: true, name: "setup" });
  const submit = h("button", { class: "btn btn--primary", type: "submit", text: mode === "login" ? "Sign in" : "Create admin" });
  const form = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; submit.disabled = true;
    try {
      if (mode === "setup") { await api("/api/setup", { method: "POST", body: { setup_token: setup.value, username: user.value, password: pass.value } }); toast("Admin created. Sign in."); return renderGate("login"); }
      const r = await api("/api/login", { method: "POST", body: { username: user.value, password: pass.value } });
      session.set(r.token); me = r.admin; start();
    } catch (x) { err.textContent = x.message; } finally { submit.disabled = false; }
  } },
    h("label", {}, "Username", user), h("label", {}, mode === "login" ? "Password" : "Password (12+ characters)", pass),
    mode === "setup" ? h("label", {}, "Setup token (ADMIN_SETUP_TOKEN on the Worker)", setup) : null, err, submit);
  document.body.replaceChildren(h("div", { class: "gate" }, h("div", { class: "gate__card" },
    h("div", { class: "gate__brand" }, h("span", { class: "wordmark", text: "Osprey" }), h("span", { class: "side__tag", text: "Outreach console" })),
    h("p", { class: "muted small", text: mode === "login" ? "Admins only. Every Reddit post or reply needs your explicit approval." : "First run: create the first admin account. This only works while no admin exists." }),
    form,
    h("button", { class: "btn btn--ghost btn--sm", type: "button", text: mode === "login" ? "First time? Create the first admin" : "Back to sign in", onclick: () => renderGate(mode === "login" ? "setup" : "login") }))));
  user.focus();
}

async function start() {
  try { if (!me) me = (await api("/api/me")).admin; } catch (e) { if (e.status !== 401) { document.body.replaceChildren(h("div", { class: "gate" }, h("div", { class: "gate__card" }, h("h2", { text: "Can't load" }), h("p", { class: "muted", text: e.message })))); } return; }
  const main = shell(pageId);
  try { await pageRender(main, { me }); } catch (e) { if (e.status !== 401) { main.append(h("div", { class: "alert alert--block", text: e.message })); } }
}

/** Entry point for every /ads page. */
export function boot(id, render) {
  pageId = id; pageRender = render;
  if (!session.token) return renderGate();
  start();
}

export const qs = (k) => new URLSearchParams(location.search).get(k);
export const skeleton = (n = 3) => h("div", { class: "stack" }, Array.from({ length: n }, () => h("div", { class: "skeleton" })));
