import { boot, api, h, toast, fail, ago, chip, statusChip, externalLink, ask, redditPreview, contentHash, buildPayload, skeleton } from "../app.js";

let state = null;
boot("queue", async (main, { me }) => {
  const filter = h("div", { class: "seg", role: "group", "aria-label": "Filter" });
  const list = h("div", { class: "stack" }, skeleton(3));
  const views = { review: ["suggested", "draft"], approved: ["queued", "submitting", "handoff"], failed: ["failed"], rejected: ["rejected"] };
  let view = "review";
  const draw = () => { filter.replaceChildren(...Object.keys(views).map((k) => h("button", { type: "button", "aria-pressed": String(k === view), text: { review: "Review", approved: "In flight", failed: "Failed", rejected: "Rejected" }[k], onclick: () => { view = k; load(); } }))); };
  const load = async () => {
    draw();
    state = await api("/api/drafts?status=" + views[view].join(","));
    list.replaceChildren(...(state.drafts.length ? state.drafts.map((d) => card(d, me, load)) : [h("div", { class: "empty", text: { review: "Nothing waiting for review.", approved: "Nothing approved and waiting. Sent items are in History.", failed: "Nothing has failed.", rejected: "Nothing rejected." }[view] })]));
  };
  main.append(h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Approval queue" }),
    h("p", { text: "Each approval is tied to the exact text shown. Editing a draft after approving it cancels the approval, and the submitter re-checks every rule before sending." })),
    h("div", { class: "row" }, filter, h("a", { class: "btn btn--primary", href: "/ads/drafts/new/", text: "New draft" }))), list);
  await load();
});

function card(d, me, reload) {
  const blocked = d.blocks.length > 0;
  const approvable = ["suggested", "draft", "failed"].includes(d.status);
  const tone = blocked && approvable ? "blocked" : d.waits.length ? "waiting" : "ready";
  const a = d.approval;
  const side = h("div", { class: "qcard__side" },
    h("div", { class: "row" }, statusChip(d.status), chip(d.kind), chip("r/" + d.subreddit, "teal"), h("span", { class: "muted small", text: "#" + d.id + " · v" + d.version + " · " + ago(d.updated_at) })),
    d.thread_permalink ? h("div", { class: "small" }, "Replying to ", externalLink(d.thread_permalink, "the thread")) : null,
    d.reject_reason ? h("div", { class: "alert alert--block", text: d.reject_reason }) : null,
    blocked ? h("div", { class: "alert alert--block", role: "note" }, h("strong", { text: "Blocked" }), h("ul", {}, d.blocks.map((b) => h("li", { text: b.message })))) : null,
    !blocked && d.waits.length ? h("div", { class: "alert alert--wait" }, d.waits.map((w) => h("span", { text: w.message }))) : null,
    !blocked && approvable && !d.waits.length ? h("div", { class: "alert alert--ok", text: "Passes every rule right now." }) : null,
    a && a.status === "active" ? h("div", { class: "alert alert--wait", text: `Approval ${a.mode === "handoff" ? "for manual posting" : "queued"} · expires ${ago(a.expires_at)}` }) : null,
    h("div", { class: "hash", text: "Content hash " + d.content_hash.slice(0, 16) + "…" }),
    actions(d, me, reload));
  return h("article", { class: "qcard qcard--" + tone, "aria-label": `Draft ${d.id}` }, h("div", {}, redditPreview(d, { username: state?.reddit_username || "you" })), side);
}

function actions(d, me, reload) {
  const wrap = h("div", { class: "qcard__actions" });
  const run = (fn) => async () => { try { await fn(); } catch (x) { fail(x); } };
  if (["suggested", "draft", "failed"].includes(d.status)) {
    wrap.append(h("button", { class: "btn btn--approve", disabled: d.blocks.length > 0, title: d.blocks.length ? "Fix the blocks first" : null, text: "Approve", onclick: run(async () => {
      // Re-derive the hash in the browser from what's on screen; the server must agree.
      const hash = await contentHash(d);
      if (hash !== d.content_hash) throw new Error("The draft on screen doesn't match the stored hash. Reload the page.");
      const p = buildPayload(d);
      const ok = await ask({ title: "Approve this " + (d.kind === "reply" ? "reply" : "post") + "?",
        message: state.settings.submit_mode === "api" ? `It will be sent to r/${d.subreddit} by the submitter, after one last rule check.` : `You'll post it yourself on reddit.com, then paste the link back here.`,
        details: h("div", { class: "alert alert--info small" }, h("span", { text: "Approving content hash " + hash.slice(0, 24) + "…" }), h("span", { text: (p.title ? `Title: ${p.title} · ` : "") + `${(p.text || p.url || "").length} characters` })),
        confirmLabel: "Approve" });
      if (!ok) return;
      const r = await api(`/api/drafts/${d.id}/approve`, { method: "POST", body: { content_hash: hash, version: d.version } });
      toast(r.mode === "api" ? "Approved and queued for submission." : "Approved. Post it on Reddit, then record the link.");
      reload();
    }) }));
    wrap.append(h("a", { class: "btn", href: `/ads/drafts/new/?id=${d.id}`, text: "Edit" }));
    wrap.append(h("button", { class: "btn btn--danger", text: "Reject", onclick: run(async () => {
      const reason = await ask({ title: "Reject draft #" + d.id, input: { label: "Reason (optional, kept in the audit log)", multiline: true }, confirmLabel: "Reject", danger: true });
      if (reason === null) return;
      await api(`/api/drafts/${d.id}/reject`, { method: "POST", body: { reason } }); toast("Rejected."); reload();
    }) }));
  }
  if (d.status === "handoff" && d.approval?.status === "active") wrap.append(...handoff(d, reload));
  if (["queued", "handoff"].includes(d.status) && d.approval?.status === "active")
    wrap.append(h("button", { class: "btn btn--danger", text: "Cancel approval", onclick: run(async () => { await api(`/api/approvals/${d.approval.id}/cancel`, { method: "POST" }); toast("Approval cancelled."); reload(); }) }));
  wrap.append(h("button", { class: "btn", text: "Duplicate", onclick: run(async () => { const r = await api(`/api/drafts/${d.id}/duplicate`, { method: "POST" }); location.href = `/ads/drafts/new/?id=${r.id}`; }) }));
  if (d.rule && !d.rule.paused) wrap.append(h("button", { class: "btn", text: "Pause r/" + d.subreddit, onclick: run(async () => {
    if (!(await ask({ title: `Pause r/${d.subreddit}?`, message: "Nothing will be approved or sent there until you resume it on the Subreddits page.", confirmLabel: "Pause" }))) return;
    await api(`/api/subreddits/${encodeURIComponent(d.subreddit)}/pause`, { method: "POST" }); toast("Paused r/" + d.subreddit); reload();
  }) }));
  return wrap;
}

function handoff(d, reload) {
  const p = buildPayload(d);
  const open = d.kind === "reply" ? d.thread_permalink
    : `https://www.reddit.com/r/${encodeURIComponent(d.subreddit)}/submit?` + new URLSearchParams(p.kind === "self" ? { title: p.title, text: p.text } : { title: p.title, url: p.url });
  return [
    h("button", { class: "btn", text: "Copy text", onclick: async () => { await navigator.clipboard.writeText(p.text || p.url || ""); toast("Copied."); } }),
    h("a", { class: "btn btn--primary", href: open, target: "_blank", rel: "noopener noreferrer", text: "Open on Reddit" }),
    h("button", { class: "btn btn--primary", text: "Record link", onclick: async () => {
      const link = await ask({ title: "Paste the link to what you posted", input: { label: "reddit.com permalink", placeholder: "https://www.reddit.com/r/…/comments/…" }, confirmLabel: "Record" });
      if (!link) return;
      try { await api(`/api/approvals/${d.approval.id}/complete`, { method: "POST", body: { permalink: link } }); toast("Recorded."); reload(); } catch (x) { fail(x); }
    } }),
  ];
}
