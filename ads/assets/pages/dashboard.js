import { boot, api, h, toast, fail, ago, when, chip, statusChip, externalLink, ask, qs, skeleton } from "../app.js";

boot("dashboard", async (main) => {
  const flash = { connected: ["Reddit connected.", "ok"], denied: ["Reddit authorisation was cancelled.", "error"], bad_state: ["That Reddit sign-in link expired. Try again.", "error"], error: ["Reddit connection failed. See the audit log.", "error"] }[qs("reddit")];
  if (flash) { toast(...flash); history.replaceState(null, "", "/ads/"); }
  main.append(h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Dashboard" }),
    h("p", { text: "Opportunities the watcher found, what's waiting for your approval, and how close each subreddit is to its limits." })),
    h("a", { class: "btn btn--primary", href: "/ads/drafts/new/", text: "New draft" })));
  const body = h("div", { class: "stack" }, skeleton(4));
  main.append(body);
  const render = async () => {
    const d = await api("/api/dashboard");
    const tpls = (await api("/api/templates")).templates.filter((t) => t.kind === "reply");
    body.replaceChildren(
      stats(d), d.settings.kill_switch ? h("div", { class: "alert alert--block", text: "Kill switch is on: every submission is blocked until you turn it off below." }) : null,
      h("div", { class: "grid grid--2" }, opportunities(d, tpls, render), h("div", { class: "stack" }, redditPanel(d, render), controls(d, render))),
      h("div", { class: "grid grid--2" }, cooldowns(d), failures(d)));
  };
  await render();
});

function stats(d) {
  const tile = (label, value, note, href) => h(href ? "a" : "div", { class: "panel stat", href, style: null }, h("span", { class: "stat__label", text: label }), h("span", { class: "stat__value", text: value }), h("span", { class: "stat__note", text: note }));
  const rate = d.reddit.rate || {};
  return h("div", { class: "grid grid--4" },
    tile("Pending approval", d.pending_review, d.counts.suggested ? `${d.counts.suggested} suggested by the watcher` : "drafts waiting for review", "/ads/queue/"),
    tile("In flight", d.in_flight, d.counts.handoff ? `${d.counts.handoff} waiting for you to post manually` : "approved, queued for the submitter", "/ads/queue/"),
    tile("Last 24 hours", `${d.daily.used} / ${d.daily.cap}`, "submissions vs daily cap", "/ads/history/"),
    tile("Reddit API", rate.remaining != null ? Math.floor(rate.remaining) : "—", rate.reset_at ? `requests left, window resets ${ago(rate.reset_at)}` : "requests left (no calls yet)", null));
}

function opportunities(d, tpls, rerender) {
  const url = h("input", { type: "url", placeholder: "https://www.reddit.com/r/…/comments/…", required: true });
  const title = h("input", { placeholder: "Thread title (fetched automatically when Reddit is connected)" });
  const add = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault();
    try {
      let t = title.value;
      if (!t && d.reddit.connected) t = (await api("/api/reddit/thread", { method: "POST", body: { url: url.value } })).title || "";
      await api("/api/candidates", { method: "POST", body: { url: url.value, title: t } });
      toast("Thread added."); rerender();
    } catch (x) { fail(x); }
  } }, h("label", {}, "Add a thread by hand", url), title, h("div", { class: "row row--end" }, h("button", { class: "btn btn--sm", type: "submit", text: "Add thread" })));
  const list = d.opportunities.length ? h("div", { class: "list" }, d.opportunities.map((c) => {
    const pick = h("select", { "aria-label": "Reply template" }, h("option", { value: "", text: "Blank reply" }), tpls.map((t) => h("option", { value: t.id, text: t.name })));
    return h("div", { class: "item" },
      h("div", { class: "row" }, chip("r/" + c.subreddit, "teal"), c.source === "manual" ? chip("added by hand") : chip("watcher", "lav"), h("span", { class: "muted small", text: ago(c.reddit_created_at || c.created_at) })),
      h("div", { class: "item__title" }, externalLink(c.permalink, c.title)),
      c.matched_keywords ? h("div", { class: "muted small", text: "Matched: " + JSON.parse(c.matched_keywords).join(", ") }) : null,
      h("div", { class: "row" }, pick,
        h("button", { class: "btn btn--sm btn--primary", text: "Draft reply", onclick: async () => {
          try { const r = await api(`/api/candidates/${c.id}/draft`, { method: "POST", body: { template_id: pick.value || null } }); location.href = `/ads/drafts/new/?id=${r.id}`; } catch (x) { fail(x); }
        } }),
        h("button", { class: "btn btn--sm btn--ghost", text: "Dismiss", onclick: async () => { try { await api(`/api/candidates/${c.id}/dismiss`, { method: "POST" }); rerender(); } catch (x) { fail(x); } } })));
  })) : h("div", { class: "empty", text: d.watchers.length ? "No new opportunities. The watcher checks your subreddits every 15 minutes or so." : "No watchers yet. Add a subreddit and a watcher on the Subreddits page." });
  return h("section", { class: "panel" }, h("div", { class: "panel__head" }, h("h2", { text: "Recent opportunities" }), h("a", { href: "/ads/subreddits/#watchers", class: "small", text: `${d.watchers.filter((w) => w.enabled).length} watcher(s)` })), list, h("hr", { class: "divider" }), add);
}

function appForm(d, rerender, onCancel) {
  const app = d.reddit.app || {};
  const id = h("input", { name: "client_id", autocomplete: "off", spellcheck: false, required: true, placeholder: "the string under the app's name" });
  const secret = h("input", { name: "client_secret", type: "password", autocomplete: "off", required: true, placeholder: "shown next to “secret”" });
  const user = h("input", { name: "username", autocomplete: "off", spellcheck: false, required: true, value: app.username || "", placeholder: "without u/" });
  const save = h("button", { class: "btn btn--primary", type: "submit", text: "Save app" });
  const form = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault(); save.disabled = true;
    try {
      const r = await api("/api/reddit/app", { method: "PUT", body: { client_id: id.value, client_secret: secret.value, username: user.value } });
      secret.value = ""; toast(`Saved the Reddit app for u/${r.username}.`); rerender();
    } catch (x) { fail(x); save.disabled = false; }
  } },
    h("p", { class: "muted small", text: "From reddit.com/prefs/apps, a “web app” owned by the account Osprey posts as. The secret is encrypted on save and never shown again." }),
    h("div", { class: "alert alert--info small" }, h("span", { text: "The app's redirect URI must be exactly: " }), h("code", { class: "hash", text: app.redirect_uri || "https://osprey-ads-api.genocchi.workers.dev/api/reddit/callback" })),
    h("label", {}, "Client ID", id), h("label", {}, "Client secret", secret), h("label", {}, "Reddit username", user),
    h("div", { class: "row row--end" }, onCancel ? h("button", { class: "btn btn--ghost", type: "button", text: "Cancel", onclick: onCancel }) : null, save));
  return form;
}

function redditPanel(d, rerender) {
  const r = d.reddit, app = r.app || {};
  const panel = h("section", { class: "panel" }, h("div", { class: "panel__head" }, h("h2", { text: "Reddit account" })));
  const appLine = r.configured ? h("div", { class: "row small muted" },
    h("span", { text: `App ${app.client_id_hint ? app.client_id_hint + "…" : ""} · User-Agent by u/${app.username || "unknown"}` + (app.source === "worker" ? " · set as Worker secrets" : "") }),
    app.source === "dashboard" ? h("button", { class: "btn btn--sm btn--ghost", type: "button", text: "Change app", onclick: async () => {
      if (r.connected && !(await ask({ title: "Change the Reddit app?", message: "Saving a different client ID disconnects the current Reddit account; you'll connect again with the new app." }))) return;
      panel.replaceChildren(panel.firstChild, appForm(d, rerender, rerender));
    } }) : null) : null;
  let body;
  if (!r.configured) body = appForm(d, rerender);
  else if (!r.connected) body = h("div", { class: "stack" }, h("p", { class: "muted small", text: "Connect the Reddit account Osprey posts as. Scopes requested: identity, read, submit." }),
    h("button", { class: "btn btn--primary", text: "Connect Reddit", onclick: async () => { try { location.href = (await api("/api/reddit/connect", { method: "POST" })).url; } catch (x) { fail(x); } } }), appLine);
  else body = h("div", { class: "stack" },
    h("div", { class: "row" }, chip("connected", "green"), h("strong", { text: "u/" + (r.account.username || "unknown") }), h("span", { class: "muted small", text: "since " + when(r.account.connected_at) })),
    h("div", { class: "muted small", text: "Scopes: " + (r.account.scopes || "") }), appLine,
    h("div", { class: "row" }, h("button", { class: "btn btn--sm btn--danger", text: "Disconnect", onclick: async () => {
      if (!(await ask({ title: "Disconnect Reddit?", message: "Queued submissions will fail until you reconnect.", confirmLabel: "Disconnect", danger: true }))) return;
      try { await api("/api/reddit/disconnect", { method: "POST" }); rerender(); } catch (x) { fail(x); }
    } })));
  panel.append(body);
  return panel;
}

function controls(d, rerender) {
  const s = d.settings;
  const f = (name, label, value, min, max, hint) => h("label", {}, label, h("input", { type: "number", name, value, min, max, required: true }), hint ? h("span", { class: "muted small", text: hint }) : null);
  const mode = h("select", { name: "submit_mode" }, h("option", { value: "api", text: "Reddit API (submitter posts after approval)", selected: s.submit_mode === "api" }), h("option", { value: "handoff", text: "Manual hand-off (you post it on reddit.com)", selected: s.submit_mode === "handoff" }));
  const kill = h("input", { type: "checkbox", name: "kill_switch", checked: s.kill_switch });
  const form = h("form", { class: "form-grid", onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try { await api("/api/settings", { method: "PUT", body: { ...Object.fromEntries(fd), kill_switch: kill.checked } }); toast("Settings saved."); rerender(); } catch (x) { fail(x); }
  } },
    h("label", { class: "full" }, "Submission mode", mode),
    f("daily_cap", "Daily cap (all subreddits)", s.daily_cap, 0, 20, "rolling 24 hours"), f("min_gap_minutes", "Minimum gap (minutes)", s.min_gap_minutes, 0, 1440, "between any two submissions"),
    f("approval_ttl_minutes", "Approval lifetime (minutes)", s.approval_ttl_minutes, 5, 240), f("duplicate_window_days", "Cross-post window (days)", s.duplicate_window_days, 0, 365, "same text can't go to another sub"),
    h("label", { class: "check full" }, kill, "Kill switch: block every submission"),
    h("div", { class: "full row row--end" }, h("button", { class: "btn btn--primary", type: "submit", text: "Save settings" })));
  return h("section", { class: "panel" }, h("div", { class: "panel__head" }, h("h2", { text: "Limits & safety" })), form);
}

function cooldowns(d) {
  const t = Date.now();
  const rows = d.cooldowns.map((c) => {
    const cooling = c.next_allowed_at && c.next_allowed_at > t;
    const state = c.blacklisted ? chip("blacklisted", "red") : c.paused ? chip("paused", "lav") : cooling ? chip("cooling " + ago(c.next_allowed_at).replace("in ", ""), "lav") : c.max_per_day && c.last_24h >= c.max_per_day ? chip("daily max", "red") : chip("ready", "green");
    return h("tr", {}, h("td", {}, h("a", { href: "/ads/subreddits/#r-" + c.subreddit, text: "r/" + c.subreddit })), h("td", {}, state),
      h("td", { text: c.last_submitted_at ? ago(c.last_submitted_at) : "never" }), h("td", { text: `${c.last_24h} / ${c.max_per_day || "∞"}` }), h("td", { text: c.cooldown_hours + "h" }));
  });
  return h("section", { class: "panel" }, h("div", { class: "panel__head" }, h("h2", { text: "Cooldown status" })),
    rows.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Subreddit", "Status", "Last sent", "24h", "Cooldown"].map((x) => h("th", { text: x })))), h("tbody", {}, rows)))
      : h("div", { class: "empty", text: "No subreddits yet. Every subreddit needs rules before anything can be sent there." }));
}

function failures(d) {
  return h("section", { class: "panel" }, h("div", { class: "panel__head" }, h("h2", { text: "Failures & blocks" }), h("a", { class: "small", href: "/ads/history/?status=failed", text: "All history" })),
    d.failures.length ? h("div", { class: "list" }, d.failures.map((f) => h("div", { class: "item" },
      h("div", { class: "row" }, statusChip(f.status), chip("r/" + f.subreddit), h("span", { class: "muted small", text: ago(f.created_at) }), h("a", { class: "small", href: `/ads/drafts/new/?id=${f.draft_id}`, text: "Draft #" + f.draft_id })),
      h("div", { class: "small", text: f.error || "" }))))
      : h("div", { class: "empty", text: "Nothing has failed or been blocked." }));
}
