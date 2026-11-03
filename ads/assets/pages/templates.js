import { boot, api, h, toast, fail, chip, ask, redditPreview } from "../app.js";

/* Premade starters, written only from facts on osprey.build. Edit before use. */
const STARTERS = [
  { name: "Reply · server recommendation", kind: "reply", content: { body: "If you're open to something a bit different: Osprey is an upcoming Vanilla+ server set on one finite 5000×5000 island, so resources genuinely run out and players build civilisations around that. Java with native Bedrock support, and no commands to learn. It's pre-launch right now.", cta: "Details: https://osprey.build/ · Discord: https://discord.gg/4EnjKHUG4S" }, notes: "For 'looking for a server' threads. Personalise the first line to what they asked for." },
  { name: "Reply · Java + Bedrock crossplay", kind: "reply", content: { body: "Osprey might fit: it's a Java server with native Bedrock compatibility (Java: osprey.build, Bedrock: play.osprey.build port 19132). It's still pre-launch, with announcements going out on the Discord.", cta: "https://osprey.build/" }, notes: "Only where the person asked for crossplay." },
  { name: "Post · pre-launch introduction", kind: "post", content: { post_type: "text", title: "Osprey: an upcoming Vanilla+ server on one finite island (Java + Bedrock)", body: "Osprey is a pre-launch Vanilla+ Minecraft server set on a single custom 5000×5000 island with nothing but ocean at the border. Resources won't last forever, so how you play is up to you: build a civilisation with friends, trade, or go it alone.\n\n- Java, with native Bedrock compatibility\n- Run by Falcon, our own backend: no commands to learn, everything works through the Crystal item\n- Pre-launch: no open date yet", cta: "Field guide: https://osprey.build/in-depth/ · Discord: https://discord.gg/4EnjKHUG4S" }, notes: "Only for subreddits whose rules allow server ads. Check flair requirements." },
  { name: "Weekly thread · short listing", kind: "reply", content: { body: "**Osprey** | Vanilla+ | Java + Bedrock | Pre-launch\n\nOne finite 5000×5000 island where resources run out and players build civilisations around that. No commands to learn.", cta: "https://osprey.build/ · Discord: https://discord.gg/4EnjKHUG4S" }, notes: "For weekly/megathreads. Match the thread's required format if it has one." },
];

boot("templates", async (main) => {
  const list = h("div", { class: "stack" });
  const editor = h("div");
  const load = async () => {
    const { templates } = await api("/api/templates");
    list.replaceChildren(...(templates.length ? templates.map((t) => row(t)) : [h("div", { class: "empty" }, h("p", { text: "No templates yet." }),
      h("button", { class: "btn btn--primary", text: "Add the premade Osprey templates", onclick: async () => {
        try { for (const s of STARTERS) await api("/api/templates", { method: "POST", body: s }); toast("Added 4 premade templates."); load(); } catch (x) { fail(x); }
      } }))]));
  };
  const row = (t) => h("article", { class: "panel" },
    h("div", { class: "panel__head" }, h("div", { class: "row" }, h("h2", { text: t.name }), chip(t.kind, t.kind === "post" ? "teal" : "lav"), t.content.post_type && t.kind === "post" ? chip(t.content.post_type) : null),
      h("div", { class: "row" },
        h("a", { class: "btn btn--sm btn--primary", href: `/ads/drafts/new/?template=${t.id}`, text: "Use" }),
        h("button", { class: "btn btn--sm", text: "Edit", onclick: () => edit(t) }),
        h("button", { class: "btn btn--sm btn--danger", text: "Archive", onclick: async () => {
          if (!(await ask({ title: `Archive “${t.name}”?`, message: "Existing drafts keep their text.", confirmLabel: "Archive", danger: true }))) return;
          try { await api(`/api/templates/${t.id}`, { method: "DELETE" }); load(); } catch (x) { fail(x); }
        } }))),
    t.notes ? h("p", { class: "muted small", text: t.notes }) : null,
    redditPreview({ kind: t.kind, subreddit: "subreddit", thread_title: "A thread that matched your watcher", content: t.content }));

  function edit(t = null) {
    const c = t?.content || { post_type: "text" };
    const name = h("input", { value: t?.name || "", required: true });
    const kind = h("select", {}, h("option", { value: "reply", text: "Reply", selected: t?.kind !== "post" }), h("option", { value: "post", text: "Post", selected: t?.kind === "post" }));
    const ptype = h("select", {}, ["text", "link", "image"].map((k) => h("option", { value: k, text: k, selected: c.post_type === k })));
    const title = h("input", { value: c.title || "" }), body = h("textarea", { value: c.body || "", rows: 7 }), cta = h("textarea", { value: c.cta || "", rows: 2 });
    const image = h("input", { type: "url", value: c.image_url || "" }), link = h("input", { type: "url", value: c.link_url || "" }), notes = h("input", { value: t?.notes || "" });
    const form = h("form", { class: "panel stack", onsubmit: async (e) => {
      e.preventDefault();
      const payload = { name: name.value, kind: kind.value, notes: notes.value, content: { post_type: ptype.value, title: title.value, body: body.value, cta: cta.value, image_url: image.value, link_url: link.value } };
      try { await api(t ? `/api/templates/${t.id}` : "/api/templates", { method: t ? "PUT" : "POST", body: payload }); toast("Template saved."); editor.replaceChildren(); load(); } catch (x) { fail(x); }
    } },
      h("div", { class: "panel__head" }, h("h2", { text: t ? "Edit template" : "New template" })),
      h("div", { class: "form-grid" }, h("label", {}, "Name", name), h("label", {}, "Kind", kind), h("label", {}, "Post type (posts only)", ptype), h("label", {}, "Title (posts only)", title),
        h("label", { class: "full" }, "Body", body), h("label", { class: "full" }, "Call to action", cta), h("label", {}, "Image URL", image), h("label", {}, "Link URL", link), h("label", { class: "full" }, "Notes for yourself", notes)),
      h("p", { class: "small muted", text: "Placeholders: {{author}} (thread author), {{subreddit}}, {{thread_title}}. They're filled in when a draft is created." }),
      h("div", { class: "row row--end" }, h("button", { class: "btn btn--ghost", type: "button", text: "Cancel", onclick: () => editor.replaceChildren() }), h("button", { class: "btn btn--primary", type: "submit", text: "Save template" })));
    editor.replaceChildren(form); name.focus(); form.scrollIntoView({ block: "start" });
  }

  main.append(h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Templates" }), h("p", { text: "Reusable starting points. Every draft made from a template is still reviewed and approved one at a time; reword it for each community so it isn't repeated content." })),
    h("button", { class: "btn btn--primary", text: "New template", onclick: () => edit() })), editor, list);
  await load();
});
