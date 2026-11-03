import { boot, api, h, toast, fail, chip, qs, redditPreview, contentHash, externalLink, statusChip } from "../app.js";
import { LIMITS, validateDraft, fillTemplate, parseThreadRef, normSub } from "../content.js";

boot("builder", async (main) => {
  const id = qs("id");
  const [tplRes, ruleRes, existing, me] = await Promise.all([
    api("/api/templates"), api("/api/subreddits"), id ? api("/api/drafts/" + id) : null, api("/api/reddit/status").catch(() => ({})),
  ]);
  const templates = tplRes.templates, rules = ruleRes.rules;
  const locked = existing && ["submitting", "submitted"].includes(existing.status);

  const d = existing ? { kind: existing.kind, subreddit: existing.subreddit, thread_fullname: existing.thread_fullname, thread_title: existing.thread_title, thread_permalink: existing.thread_permalink, content: { ...existing.content } }
    : { kind: qs("kind") === "reply" ? "reply" : "post", subreddit: qs("sr") || "", thread_fullname: null, thread_title: null, thread_permalink: null, content: { post_type: "text", title: "", body: "", cta: "", image_url: "", link_url: "", flair_id: "", flair_text: "" } };
  let templateId = existing?.template_id || null;

  /* ---------- fields ---------- */
  const inp = (name, attrs = {}) => h("input", { name, value: d.content[name] ?? "", ...attrs });
  const f = {
    subreddit: h("input", { name: "subreddit", list: "sub-list", value: d.subreddit, placeholder: "e.g. mcservers", autocomplete: "off", required: true }),
    thread: h("input", { name: "thread", type: "url", value: d.thread_permalink || "", placeholder: "https://www.reddit.com/r/…/comments/…" }),
    title: inp("title", { maxlength: LIMITS.TITLE_MAX + 50 }),
    body: h("textarea", { name: "body", value: d.content.body, rows: 9, placeholder: "Write like a member of the community, not an ad. Markdown: **bold**, [text](url), - lists." }),
    cta: h("textarea", { name: "cta", value: d.content.cta, rows: 2, placeholder: "e.g. Discord: https://discord.gg/4EnjKHUG4S" }),
    image_url: inp("image_url", { type: "url", placeholder: "https://… (hosted image)" }),
    link_url: inp("link_url", { type: "url", placeholder: "https://osprey.build/" }),
    flair_id: inp("flair_id", { placeholder: "flair template id" }),
    flair_text: inp("flair_text", { placeholder: "shown on the preview" }),
  };
  const subList = h("datalist", { id: "sub-list" }, rules.map((r) => h("option", { value: r.subreddit })));
  const kindSeg = h("div", { class: "seg", role: "group", "aria-label": "Draft type" });
  const typeSeg = h("div", { class: "seg", role: "group", "aria-label": "Post type" });
  const tplSel = h("select", { "aria-label": "Template" });
  const errors = h("div", { class: "stack" });
  const preview = h("div");
  const ruleBox = h("div");
  const hashOut = h("div", { class: "hash" });
  const counters = { title: h("span", { class: "counter" }), body: h("span", { class: "counter" }) };

  const rows = {
    thread: h("div", { class: "full stack" }, h("label", {}, "Thread to reply to", h("div", { class: "row" }, h("div", { class: "grow" }, f.thread),
      h("button", { class: "btn btn--sm", type: "button", text: "Look up", onclick: lookup }))), h("div", { class: "small muted", id: "thread-info" })),
    type: h("div", { class: "full stack" }, h("span", { class: "small muted", text: "Post type" }), typeSeg),
    title: h("label", { class: "full" }, h("span", { class: "label-row" }, "Title", counters.title), f.title),
    link: h("label", { class: "full" }, "Link URL", f.link_url),
    flair: h("fieldset", { class: "full" }, h("legend", { text: "Flair" }), h("div", { class: "form-grid" }, h("label", {}, "Flair ID", f.flair_id), h("label", {}, "Flair text", f.flair_text))),
  };

  function drawSegs() {
    kindSeg.replaceChildren(...["post", "reply"].map((k) => h("button", { type: "button", "aria-pressed": String(d.kind === k), text: k === "post" ? "New post" : "Reply to thread", disabled: locked, onclick: () => { d.kind = k; drawSegs(); drawTpl(); update(); } })));
    typeSeg.replaceChildren(...[["text", "Text"], ["link", "Link"], ["image", "Image"]].map(([k, l]) => h("button", { type: "button", "aria-pressed": String(d.content.post_type === k), text: l, disabled: locked, onclick: () => { d.content.post_type = k; drawSegs(); update(); } })));
    const post = d.kind === "post";
    rows.thread.hidden = post; rows.type.hidden = !post; rows.title.hidden = !post; rows.flair.hidden = !post; rows.link.hidden = !(post && d.content.post_type === "link");
  }
  function drawTpl() {
    tplSel.replaceChildren(h("option", { value: "", text: "— Start from a template —" }), ...templates.filter((t) => t.kind === d.kind).map((t) => h("option", { value: t.id, text: t.name })));
  }
  function applyTemplate(t) {
    const vars = { subreddit: normSub(f.subreddit.value), thread_title: d.thread_title || "", author: "" };
    for (const k of ["title", "body", "cta", "image_url", "link_url"]) { d.content[k] = fillTemplate(t.content[k] || "", vars); f[k].value = d.content[k]; }
    if (t.content.post_type) d.content.post_type = t.content.post_type;
    templateId = t.id; drawSegs(); update(); toast(`Template “${t.name}” applied.`);
  }
  tplSel.addEventListener("change", () => { const t = templates.find((x) => String(x.id) === tplSel.value); if (t) applyTemplate(t); tplSel.value = ""; });

  async function lookup() {
    const ref = parseThreadRef(f.thread.value);
    const info = document.getElementById("thread-info");
    if (!ref) { info.textContent = "That isn't a Reddit thread link."; return; }
    d.thread_fullname = ref.fullname; d.thread_permalink = f.thread.value.trim();
    if (ref.subreddit && !f.subreddit.value) f.subreddit.value = ref.subreddit;
    try {
      const t = await api("/api/reddit/thread", { method: "POST", body: { url: f.thread.value } });
      if (t.title) { d.thread_title = t.title; d.thread_permalink = t.permalink || d.thread_permalink; if (t.subreddit) f.subreddit.value = t.subreddit; info.replaceChildren("Found: ", externalLink(d.thread_permalink, t.title), t.locked || t.archived ? " (locked/archived — replies will fail)" : ""); }
      else info.textContent = "Linked " + ref.fullname + ". Connect Reddit to fetch the title automatically.";
    } catch (x) { info.textContent = x.message; }
    update();
  }

  /* ---------- live update ---------- */
  let seq = 0;
  async function update() {
    d.subreddit = normSub(f.subreddit.value);
    for (const k of ["title", "body", "cta", "image_url", "link_url", "flair_id", "flair_text"]) d.content[k] = f[k].value;
    if (d.kind === "reply" && !parseThreadRef(f.thread.value)) { d.thread_fullname = null; }
    else if (d.kind === "reply") d.thread_fullname = parseThreadRef(f.thread.value).fullname;
    const tl = d.content.title.trim().length, bl = (d.content.body + d.content.cta).length, bmax = d.kind === "reply" ? LIMITS.COMMENT_MAX : LIMITS.POST_BODY_MAX;
    counters.title.textContent = `${tl}/${LIMITS.TITLE_MAX}`; counters.title.classList.toggle("over", tl > LIMITS.TITLE_MAX);
    counters.body.textContent = `${bl}/${bmax}`; counters.body.classList.toggle("over", bl > bmax);
    preview.replaceChildren(redditPreview(d, { username: me.account?.username || "you" }));
    const rule = rules.find((r) => r.subreddit === d.subreddit);
    ruleBox.replaceChildren(ruleSummary(rule, d));
    const errs = validateDraft(d);
    errors.replaceChildren(...(errs.length ? [h("div", { class: "alert alert--info" }, h("ul", {}, errs.map((e) => h("li", { text: e.message }))))] : []));
    const n = ++seq; const hash = await contentHash(d); if (n === seq) hashOut.textContent = "Content hash " + hash.slice(0, 24) + "…";
  }
  function ruleSummary(r, d) {
    if (!d.subreddit) return h("span");
    if (!r) return h("div", { class: "alert alert--block" }, h("span", { text: `r/${d.subreddit} has no rules yet, so it can't be approved. ` }), h("a", { href: "/ads/subreddits/?add=" + d.subreddit, text: "Add rules" }));
    const items = [];
    if (r.blacklisted) items.push(chip("blacklisted", "red"));
    if (r.paused) items.push(chip("paused", "lav"));
    items.push(chip(r.ads_allowed ? "posts allowed" : "no promo posts", r.ads_allowed ? "green" : "red"));
    items.push(chip(r.comments_allowed ? "replies allowed" : "no promo replies", r.comments_allowed ? "green" : "red"));
    if (r.weekly_thread_only) items.push(chip("weekly thread only" + (r.weekly_thread_match ? `: “${r.weekly_thread_match}”` : ""), "lav"));
    if (r.required_flair) items.push(chip("flair required", "lav"));
    items.push(chip(`cooldown ${r.cooldown_hours}h`), chip(`max ${r.max_per_day}/day`));
    if (r.required_flair && d.kind === "post" && !f.flair_id.value && r.flair_id) { f.flair_id.value = r.flair_id; f.flair_text.value = r.flair_text || ""; d.content.flair_id = r.flair_id; d.content.flair_text = r.flair_text || ""; }
    const stop = r.blacklisted ? `r/${r.subreddit} is blacklisted. Nothing can be approved for it.`
      : r.paused ? `r/${r.subreddit} is paused. Approval is blocked until you resume it.`
      : d.kind === "post" && !r.ads_allowed ? `r/${r.subreddit} doesn't allow promotional posts, so this post would be blocked at approval.`
      : d.kind === "post" && r.weekly_thread_only ? `r/${r.subreddit} only allows promotion in its weekly thread. Write a reply to that thread instead.`
      : d.kind === "reply" && !r.comments_allowed ? `r/${r.subreddit} doesn't allow promotional replies, so this reply would be blocked at approval.` : null;
    return h("div", { class: "stack" }, stop ? h("div", { class: "alert alert--block", text: stop }) : null, h("div", { class: "row" }, items), r.rules_url ? h("div", { class: "small" }, externalLink(r.rules_url, "Read the subreddit rules")) : null, r.notes ? h("div", { class: "small muted", text: r.notes }) : null);
  }
  for (const el of Object.values(f)) el.addEventListener("input", update);
  f.thread.addEventListener("change", lookup);

  /* ---------- save ---------- */
  const saveBtn = h("button", { class: "btn btn--primary", type: "submit", text: existing ? "Save changes" : "Save to queue", disabled: locked });
  const form = h("form", { class: "panel stack", onsubmit: async (e) => {
    e.preventDefault(); await update();
    const errs = validateDraft(d);
    if (errs.length) { toast(errs[0].message, "error"); return; }
    saveBtn.disabled = true;
    try {
      const body = { ...d, template_id: templateId, candidate_id: existing?.candidate_id || null };
      if (existing) {
        const r = await api("/api/drafts/" + existing.id, { method: "PUT", body });
        toast(r.changed && existing.approval?.status === "active" ? "Saved. The earlier approval was cancelled because the content changed." : "Saved.");
      } else await api("/api/drafts", { method: "POST", body });
      location.href = "/ads/queue/";
    } catch (x) { fail(x); saveBtn.disabled = false; }
  } },
    h("div", { class: "panel__head" }, h("h2", { text: existing ? `Draft #${existing.id}` : "Compose" }), h("div", { class: "row" }, existing ? statusChip(existing.status) : null, tplSel)),
    locked ? h("div", { class: "alert alert--info", text: "This draft has been sent and can't be edited. Duplicate it from the queue to reuse it." }) : null,
    existing?.approval?.status === "active" ? h("div", { class: "alert alert--wait", text: "This draft is approved. Changing the content will cancel that approval." }) : null,
    h("div", {}, kindSeg),
    h("div", { class: "form-grid" },
      h("label", { class: "full" }, "Subreddit", f.subreddit), subList,
      rows.thread, rows.type, rows.title,
      h("label", { class: "full" }, h("span", { class: "label-row" }, d.kind === "reply" ? "Reply" : "Body", counters.body), f.body),
      h("label", { class: "full" }, "Call to action (added after the body)", f.cta),
      h("label", { class: "full" }, "Image URL", f.image_url, h("span", { class: "small muted", text: "Image posts link to this URL. Text posts and replies add it as a link at the end." })),
      rows.link, rows.flair),
    errors,
    h("div", { class: "row row--end" }, h("a", { class: "btn btn--ghost", href: "/ads/queue/", text: "Cancel" }), saveBtn));

  main.append(h("div", { class: "page-head" }, h("div", {}, h("h1", { text: existing ? "Edit draft" : "New draft" }),
    h("p", { text: "Saving puts the draft in the approval queue. Nothing is sent until you approve it there." }))),
    h("div", { class: "grid grid--builder" }, form,
      h("aside", { class: "panel panel--sticky stack", "aria-label": "Preview" }, h("div", { class: "panel__head" }, h("h2", { text: "Live preview" }), chip("exact text that will be sent", "teal")), preview, hashOut, h("hr", { class: "divider" }), h("h3", { text: "Subreddit rules" }), ruleBox)));
  drawSegs(); drawTpl(); update();
  if (qs("template")) { const t = templates.find((x) => String(x.id) === qs("template")); if (t) { d.kind = t.kind; drawSegs(); drawTpl(); applyTemplate(t); } }
});
