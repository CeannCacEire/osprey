import { boot, api, h, fail, chip, statusChip, externalLink, when, ago, qs } from "../app.js";

boot("history", async (main) => {
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Filter submissions" });
  const subs = h("div"), auditBox = h("tbody"), more = h("button", { class: "btn btn--sm", text: "Load older entries" });
  let filter = qs("status") || "";
  let oldest = null;
  const loadSubs = async () => {
    seg.replaceChildren(...[["", "All"], ["submitted", "Submitted"], ["failed", "Failed"], ["blocked", "Blocked"]].map(([k, l]) => h("button", { type: "button", "aria-pressed": String(k === filter), text: l, onclick: () => { filter = k; loadSubs(); } })));
    const { submissions } = await api("/api/history" + (filter ? "?status=" + filter : ""));
    subs.replaceChildren(submissions.length ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["When", "Status", "Where", "What", "Approved", "Result"].map((x) => h("th", { text: x })))),
      h("tbody", {}, submissions.map((s) => h("tr", {},
        h("td", { text: when(s.created_at) }), h("td", {}, statusChip(s.status), " ", chip(s.mode === "handoff" ? "manual" : "api")),
        h("td", {}, h("div", { text: "r/" + s.subreddit }), h("div", { class: "muted small", text: s.kind })),
        h("td", {}, h("div", { class: "item__title", text: s.title || s.thread_title || "Reply" }), h("a", { class: "small", href: `/ads/drafts/new/?id=${s.draft_id}`, text: "Draft #" + s.draft_id }), h("div", { class: "hash", text: s.content_hash.slice(0, 16) + "…" })),
        h("td", {}, h("div", { class: "small", text: "by " + (s.approved_by || "?") }), h("div", { class: "muted small", text: when(s.approved_at) })),
        h("td", {}, s.permalink ? externalLink(s.permalink, "Permalink") : null, s.error ? h("div", { class: "small", text: s.error }) : null,
          s.ratelimit_remaining != null ? h("div", { class: "muted small", text: `${Math.floor(s.ratelimit_remaining)} API calls left after` }) : null))))))
      : h("div", { class: "empty", text: "No submissions yet." }));
  };
  const loadAudit = async (reset) => {
    const { entries } = await api("/api/audit" + (oldest && !reset ? "?before=" + oldest : ""));
    if (reset) auditBox.replaceChildren();
    for (const e of entries) {
      auditBox.append(h("tr", {}, h("td", { title: when(e.at), text: ago(e.at) }), h("td", {}, chip(e.actor, e.actor.startsWith("admin") ? "teal" : "lav")), h("td", { text: e.action }),
        h("td", { text: e.entity_type ? `${e.entity_type} ${e.entity_id ?? ""}` : "" }), h("td", {}, e.detail ? h("code", { class: "small hash", text: JSON.stringify(e.detail) }) : null)));
      oldest = e.id;
    }
    more.hidden = entries.length < 100;
  };
  more.addEventListener("click", () => loadAudit(false).catch(fail));
  main.append(h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "History" }), h("p", { text: "Every submission attempt with its approval, and the full audit log of who did what." }))),
    h("section", { class: "panel stack" }, h("div", { class: "panel__head" }, h("h2", { text: "Submissions" }), seg), subs),
    h("section", { class: "panel stack" }, h("h2", { text: "Audit log" }), h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["When", "Actor", "Action", "Entity", "Detail"].map((x) => h("th", { text: x })))), auditBox)), more));
  await Promise.all([loadSubs(), loadAudit(true)]);
});
