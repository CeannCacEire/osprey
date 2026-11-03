import { boot, api, h, toast, fail, chip, ask, ago, qs, externalLink } from "../app.js";
import { normSub } from "../content.js";

boot("subreddits", async (main) => {
  const rulesBox = h("div", { class: "stack" }), watchBox = h("div", { class: "stack" }), editor = h("div");
  let rules = [], templates = [], watchers = [], defaults = [];
  const load = async () => {
    [rules, { watchers, default_keywords: defaults }, { templates }] = await Promise.all([api("/api/subreddits").then((r) => r.rules), api("/api/watchers"), api("/api/templates")]);
    rulesBox.replaceChildren(rules.length ? ruleTable() : h("div", { class: "empty", text: "No subreddits yet. Add one, read its rules, and set what's allowed. Subreddits without rules are always blocked." }));
    watchBox.replaceChildren(...(watchers.length ? watchers.map(watcherRow) : [h("div", { class: "empty", text: "No watchers. A watcher scans one of your subreddits for threads like “looking for a server” and lists them as opportunities. It never posts." })]));
  };

  /* ---------- rules ---------- */
  const yes = (v, on, off, tone = "green") => chip(v ? on : off, v ? tone : "");
  function ruleTable() {
    return h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Subreddit", "Posts", "Replies", "Weekly only", "Flair", "Cooldown", "Max/day", "Status", ""].map((x) => h("th", { text: x })))),
      h("tbody", {}, rules.map((r) => h("tr", { id: "r-" + r.subreddit },
        h("td", {}, r.rules_url ? externalLink(r.rules_url, "r/" + r.subreddit) : h("span", { text: "r/" + r.subreddit })),
        h("td", {}, yes(r.ads_allowed, "allowed", "no")), h("td", {}, yes(r.comments_allowed, "allowed", "no")),
        h("td", {}, r.weekly_thread_only ? chip(r.weekly_thread_match || "yes", "lav") : h("span", { class: "muted", text: "—" })),
        h("td", {}, r.required_flair ? chip(r.flair_text || r.flair_id || "required, not set", r.flair_id ? "lav" : "red") : h("span", { class: "muted", text: "—" })),
        h("td", { text: r.cooldown_hours + "h" }), h("td", { text: r.max_per_day }),
        h("td", {}, r.blacklisted ? chip("blacklisted", "red") : r.paused ? chip("paused", "lav") : chip("active", "green")),
        h("td", {}, h("div", { class: "row" },
          h("button", { class: "btn btn--sm", text: "Edit", onclick: () => editRule(r) }),
          !r.blacklisted ? h("button", { class: "btn btn--sm", text: r.paused ? "Resume" : "Pause", onclick: async () => { try { await api(`/api/subreddits/${r.subreddit}/pause`, { method: "POST", body: { paused: !r.paused } }); load(); } catch (x) { fail(x); } } }) : null)))))));
  }
  function editRule(r = null, preset = "") {
    const v = r || { subreddit: preset, ads_allowed: 0, comments_allowed: 0, weekly_thread_only: 0, required_flair: 0, cooldown_hours: 168, max_per_day: 1, blacklisted: 0, paused: 0 };
    const name = h("input", { value: v.subreddit || "", required: true, disabled: Boolean(r), placeholder: "mcservers" });
    const cb = (k, label, hint) => h("label", { class: "check" }, h("input", { type: "checkbox", name: k, checked: Boolean(v[k]) }), h("span", {}, label, hint ? h("span", { class: "muted small", text: " — " + hint }) : null));
    const txt = (k, label, attrs = {}) => h("label", {}, label, h("input", { name: k, value: v[k] ?? "", ...attrs }));
    const form = h("form", { class: "panel stack", onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form), body = {};
      for (const el of form.querySelectorAll("input[name]")) body[el.name] = el.type === "checkbox" ? el.checked : el.value;
      const sub = normSub(r ? r.subreddit : name.value);
      try { await api(`/api/subreddits/${encodeURIComponent(sub)}`, { method: "PUT", body }); toast(`Saved r/${sub}.`); editor.replaceChildren(); load(); } catch (x) { fail(x); }
    } },
      h("div", { class: "panel__head" }, h("h2", { text: r ? `r/${r.subreddit}` : "Add subreddit" }), r ? null : chip("defaults are strict: nothing allowed until you allow it", "lav")),
      h("div", { class: "form-grid" },
        h("label", {}, "Subreddit", name), txt("rules_url", "Link to its rules", { type: "url", placeholder: "https://www.reddit.com/r/…/about/rules" }),
        h("fieldset", { class: "full" }, h("legend", { text: "What's allowed" }),
          cb("ads_allowed", "Promotional posts allowed", "you may make your own post about Osprey"),
          cb("comments_allowed", "Promotional replies allowed", "you may recommend Osprey in relevant threads"),
          cb("weekly_thread_only", "Weekly / megathread only", "posts are blocked; replies only in the thread below"),
          txt("weekly_thread_match", "Megathread title contains", { placeholder: "Weekly Server Thread" })),
        h("fieldset", { class: "full" }, h("legend", { text: "Flair" }), cb("required_flair", "Posts require flair"),
          h("div", { class: "form-grid" }, txt("flair_id", "Flair template ID", { placeholder: "from the sub's flair list" }), txt("flair_text", "Flair text"))),
        txt("cooldown_hours", "Cooldown (hours)", { type: "number", min: 0, max: 2160 }), txt("max_per_day", "Max per 24 hours", { type: "number", min: 0, max: 10 }),
        h("fieldset", { class: "full" }, h("legend", { text: "Stop" }), cb("paused", "Paused", "temporarily block everything here"), cb("blacklisted", "Blacklisted", "never post here; also disables its watchers")),
        h("label", { class: "full" }, "Notes", h("input", { name: "notes", value: v.notes || "", placeholder: "e.g. mods ask for [Java] [Bedrock] tags in the title" }))),
      h("div", { class: "row row--end" },
        r ? h("button", { class: "btn btn--danger", type: "button", text: "Delete rule", onclick: async () => {
          if (!(await ask({ title: `Delete rules for r/${r.subreddit}?`, message: "It will be blocked again until you add rules. To keep it permanently off-limits, blacklist it instead.", confirmLabel: "Delete", danger: true }))) return;
          try { await api(`/api/subreddits/${r.subreddit}`, { method: "DELETE" }); editor.replaceChildren(); load(); } catch (x) { fail(x); }
        } }) : null,
        h("button", { class: "btn btn--ghost", type: "button", text: "Cancel", onclick: () => editor.replaceChildren() }), h("button", { class: "btn btn--primary", type: "submit", text: "Save rules" })));
    editor.replaceChildren(form); form.scrollIntoView({ block: "start" }); (r ? form.querySelector("input[name=rules_url]") : name).focus();
  }

  /* ---------- watchers ---------- */
  function watcherRow(w) {
    return h("article", { class: "item" },
      h("div", { class: "row" }, chip("r/" + w.subreddit, "teal"), w.enabled ? chip("on", "green") : chip("off"), h("span", { class: "muted small", text: `every ${w.interval_minutes} min · posts up to ${w.max_age_hours}h old · last scan ${ago(w.last_scanned_at)}` })),
      w.last_error ? h("div", { class: "alert alert--block small", text: w.last_error }) : null,
      h("div", { class: "small muted", text: "Keywords: " + w.keywords.join(", ") }),
      w.exclude.length ? h("div", { class: "small muted", text: "Ignore: " + w.exclude.join(", ") }) : null,
      w.template_id ? h("div", { class: "small muted", text: "Suggests a reply from: " + (templates.find((t) => t.id === w.template_id)?.name || "template #" + w.template_id) }) : null,
      h("div", { class: "row" },
        h("button", { class: "btn btn--sm", text: "Scan now", onclick: async (e) => { e.target.disabled = true; try { const r = await api(`/api/watchers/${w.id}/scan`, { method: "POST" }); toast(r.skipped ? "Skipped: subreddit is paused or blacklisted." : `Checked ${r.checked ?? 0} posts, ${r.found} new.`); load(); } catch (x) { fail(x); e.target.disabled = false; } } }),
        h("button", { class: "btn btn--sm", text: "Edit", onclick: () => editWatcher(w) }),
        h("button", { class: "btn btn--sm btn--danger", text: "Delete", onclick: async () => { if (!(await ask({ title: "Delete this watcher?", confirmLabel: "Delete", danger: true }))) return; try { await api(`/api/watchers/${w.id}`, { method: "DELETE" }); load(); } catch (x) { fail(x); } } })));
  }
  function editWatcher(w = null) {
    const usable = rules.filter((r) => !r.blacklisted);
    if (!usable.length) return toast("Add a subreddit's rules first.", "error");
    const sub = h("select", { required: true }, usable.map((r) => h("option", { value: r.subreddit, text: "r/" + r.subreddit, selected: w?.subreddit === r.subreddit })));
    const kw = h("textarea", { rows: 6, value: (w?.keywords || defaults).join("\n") });
    const ex = h("textarea", { rows: 3, value: (w?.exclude || []).join("\n"), placeholder: "e.g. modpack\nbedwars" });
    const tpl = h("select", {}, h("option", { value: "", text: "Don't suggest a draft" }), templates.filter((t) => t.kind === "reply").map((t) => h("option", { value: t.id, text: t.name, selected: w?.template_id === t.id })));
    const interval = h("input", { type: "number", min: 15, max: 1440, value: w?.interval_minutes ?? 60 }), age = h("input", { type: "number", min: 1, max: 168, value: w?.max_age_hours ?? 48 });
    const on = h("input", { type: "checkbox", checked: w ? Boolean(w.enabled) : true });
    const form = h("form", { class: "panel stack", onsubmit: async (e) => {
      e.preventDefault();
      const body = { subreddit: sub.value, keywords: kw.value, exclude: ex.value, template_id: tpl.value || null, interval_minutes: interval.value, max_age_hours: age.value, enabled: on.checked };
      try { await api(w ? `/api/watchers/${w.id}` : "/api/watchers", { method: w ? "PUT" : "POST", body }); toast("Watcher saved."); editor.replaceChildren(); load(); } catch (x) { fail(x); }
    } },
      h("div", { class: "panel__head" }, h("h2", { text: w ? "Edit watcher" : "New watcher" }), chip("finds threads only, never posts", "teal")),
      h("div", { class: "form-grid" }, h("label", {}, "Subreddit", sub), h("label", {}, "Suggest a reply draft from", tpl),
        h("label", { class: "full" }, "Match any of these phrases (one per line)", kw), h("label", { class: "full" }, "Ignore threads containing", ex),
        h("label", {}, "Scan every (minutes)", interval), h("label", {}, "Ignore posts older than (hours)", age), h("label", { class: "check full" }, on, "Enabled")),
      h("div", { class: "row row--end" }, h("button", { class: "btn btn--ghost", type: "button", text: "Cancel", onclick: () => editor.replaceChildren() }), h("button", { class: "btn btn--primary", type: "submit", text: "Save watcher" })));
    editor.replaceChildren(form); form.scrollIntoView({ block: "start" });
  }

  main.append(h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Subreddits" }), h("p", { text: "Read each community's rules and record them here. Anything not explicitly allowed is blocked, as are blacklisted or paused subreddits, missing flair, cooldowns and repeated text." })),
    h("div", { class: "row" }, h("button", { class: "btn", text: "New watcher", onclick: () => editWatcher() }), h("button", { class: "btn btn--primary", text: "Add subreddit", onclick: () => editRule() }))),
    editor, h("section", { class: "panel stack" }, h("h2", { text: "Rules" }), rulesBox), h("section", { class: "panel stack", id: "watchers" }, h("h2", { text: "Watchers" }), watchBox));
  await load();
  if (qs("add")) editRule(null, qs("add"));
});
