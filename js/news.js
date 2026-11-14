/* =========================================================================
   Osprey: Dispatches (News) feed
   -------------------------------------------------------------------------
   Fetches the announcements JSON from OSPREY_CONFIG.NEWS_ENDPOINT and renders
   up to NEWS_LIMIT posts, newest first.

   Safety model:
   - Every piece of feed text goes into the page via textContent or
     createTextNode. innerHTML is never used with feed data.
   - Links are recognised by a restricted pattern, parsed with URL(), and
     kept only if they are http(s). Anything else stays plain text.
   - Discord markdown (headings, -# subtext, lists, quotes, code, bold,
     italic, underline, strikethrough, spoilers, masked links) is parsed
     into real elements built with createElement, never markup strings.
   - Long bodies are collapsed to a preview with a "Read more" toggle, and
     only the latest VISIBLE posts show until "Show older" is pressed.
   - "Read on Discord" appears only when the post URL is on discord.com.
   ========================================================================= */
(function () {
  "use strict";

  var cfg = window.OSPREY_CONFIG || {};
  var root = document.querySelector("[data-news]");
  if (!root) return;

  var list = root.querySelector("[data-news-list]");
  var status = root.querySelector("[data-news-status]");
  var DISCORD = cfg.DISCORD_URL || "https://discord.gg/4EnjKHUG4S";
  var LIMIT = cfg.NEWS_LIMIT || 5;
  var VISIBLE = cfg.NEWS_VISIBLE || 3; /* posts shown before "Show older" */

  /* ---------- helpers ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function safeHttpUrl(raw) {
    try {
      var u = new URL(raw);
      return (u.protocol === "https:" || u.protocol === "http:") ? u.href : null;
    } catch (e) { return null; }
  }

  function isDiscordUrl(raw) {
    var href = safeHttpUrl(raw);
    if (!href) return null;
    var host = new URL(href).hostname.toLowerCase();
    var ok = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com", "www.discord.com"];
    return ok.indexOf(host) !== -1 && new URL(href).protocol === "https:" ? href : null;
  }

  /* Discord tokens that would otherwise show as raw IDs. */
  function cleanDiscordTokens(s) {
    return s
      .replace(/<a?:([A-Za-z0-9_~]+):\d+>/g, ":$1:")
      .replace(/<@&\d+>/g, "@role")
      .replace(/<@!?\d+>/g, "@member")
      .replace(/<#\d+>/g, "#channel")
      .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, function (_, t) {
        var d = new Date(Number(t) * 1000);
        return isNaN(d) ? "" : d.toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short" });
      })
      .replace(/<(https?:\/\/[^\s>]+)>/g, "$1"); /* <url> = suppressed embed */
  }

  /* ---------- Discord markdown: inline ---------- */
  function makeLink(text, href, cls) {
    var a = el("a", cls || "dispatch__link");
    a.href = href;
    a.rel = "noopener noreferrer nofollow";
    a.target = "_blank";
    appendInline(a, text, true);
    return a;
  }

  /* Ordered by priority when two patterns start at the same index. */
  var INLINE = [
    { re: /`([^`\n]+)`/, build: function (m) { return el("code", "dispatch__code", m[1]); } },
    { link: true, re: /\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/, build: function (m) {
        var href = safeHttpUrl(m[2]);
        if (!href) return document.createTextNode(m[1]);
        return makeLink(m[1], href);
      } },
    { re: /\|\|([\s\S]+?)\|\|/, build: function (m, inLink) {
        var sp = el("span", "dispatch__spoiler");
        sp.title = "Spoiler: click to reveal";
        sp.tabIndex = 0;
        sp.setAttribute("role", "button");
        sp.setAttribute("aria-label", "Spoiler, activate to reveal");
        var reveal = function () { sp.classList.add("is-revealed"); sp.removeAttribute("role"); sp.removeAttribute("aria-label"); sp.removeAttribute("tabindex"); };
        sp.addEventListener("click", reveal);
        sp.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reveal(); } });
        appendInline(sp, m[1], inLink);
        return sp;
      } },
    { re: /\*\*\*([\s\S]+?)\*\*\*/, build: function (m, inLink) {
        var b = el("strong"), i = el("em");
        appendInline(i, m[1], inLink); b.appendChild(i); return b;
      } },
    { re: /\*\*([\s\S]+?)\*\*/, wrap: "strong" },
    { re: /__([\s\S]+?)__/, wrap: "u" },
    { re: /~~([\s\S]+?)~~/, wrap: "s" },
    { re: /\*(?!\s)([^*\n]+?)\*/, wrap: "em" },
    { re: /\b_([^_\n]+?)_\b/, wrap: "em" },
    { re: /https?:\/\/[^\s<>"'`]+/, url: true }
  ];

  function appendInline(parent, text, inLink) {
    while (text) {
      var best = null, bestRule = null;
      for (var r = 0; r < INLINE.length; r++) {
        var rule = INLINE[r];
        if (inLink && (rule.url || rule.link)) continue; /* no links inside links */
        var m = rule.re.exec(text);
        if (m && (!best || m.index < best.index)) { best = m; bestRule = rule; }
      }
      if (!best) { parent.appendChild(document.createTextNode(text)); return; }
      if (best.index > 0) parent.appendChild(document.createTextNode(text.slice(0, best.index)));

      var consumed = best[0].length;
      if (bestRule.url) {
        var raw = best[0].replace(/[).,!?:;]+$/, "");
        consumed = raw.length;
        var href = safeHttpUrl(raw);
        parent.appendChild(href ? makeLink(raw, href) : document.createTextNode(raw));
      } else if (bestRule.wrap) {
        var w = el(bestRule.wrap);
        appendInline(w, best[1], inLink);
        parent.appendChild(w);
      } else {
        parent.appendChild(bestRule.build(best, inLink));
      }
      text = text.slice(best.index + consumed);
    }
  }

  /* Inline text that keeps single line breaks as <br>, like Discord. */
  function appendLines(parent, lines) {
    for (var i = 0; i < lines.length; i++) {
      if (i) parent.appendChild(el("br"));
      appendInline(parent, lines[i]);
    }
  }

  /* ---------- Discord markdown: blocks ---------- */
  var RE_FENCE = /^```(\w*)\s*$/;
  var RE_HEAD = /^(#{1,3})\s+(.+)$/;
  var RE_SUB = /^-#\s+(.+)$/;
  var RE_QUOTE_ALL = /^>>>\s?(.*)$/;
  var RE_QUOTE = /^>\s?(.*)$/;
  var RE_UL = /^(\s*)[-*]\s+(.+)$/;
  var RE_OL = /^(\s*)(\d{1,3})[.)]\s+(.+)$/;

  function renderBlocks(parent, text) {
    var lines = text.split("\n");
    var i = 0, para = [];

    function flush() {
      if (!para.length) return;
      var p = el("p", "dispatch__p");
      appendLines(p, para);
      parent.appendChild(p);
      para = [];
    }

    while (i < lines.length) {
      var line = lines[i], m;

      if (!line.trim()) { flush(); i++; continue; }

      if ((m = RE_FENCE.exec(line.trim())) || /^```/.test(line.trim())) {
        flush();
        var code = [], firstRest = line.trim().replace(/^```\w*/, "");
        var closedSameLine = /```$/.test(firstRest);
        if (closedSameLine) { code.push(firstRest.replace(/```$/, "")); i++; }
        else {
          if (firstRest && !m) code.push(firstRest);
          i++;
          while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
          i++; /* closing fence */
        }
        var pre = el("pre", "dispatch__pre");
        pre.appendChild(el("code", null, code.join("\n")));
        parent.appendChild(pre);
        continue;
      }

      if ((m = RE_HEAD.exec(line))) {
        flush();
        var h = el("h" + (m[1].length + 3), "dispatch__h dispatch__h--" + m[1].length);
        appendInline(h, m[2]);
        parent.appendChild(h);
        i++; continue;
      }

      if ((m = RE_SUB.exec(line))) {
        flush();
        var sub = el("p", "dispatch__subtext");
        appendInline(sub, m[1]);
        parent.appendChild(sub);
        i++; continue;
      }

      if ((m = RE_QUOTE_ALL.exec(line))) {
        flush();
        var bqAll = el("blockquote", "dispatch__quote");
        renderBlocks(bqAll, [m[1]].concat(lines.slice(i + 1)).join("\n"));
        parent.appendChild(bqAll);
        return;
      }

      if (RE_QUOTE.test(line)) {
        flush();
        var q = [];
        while (i < lines.length && (m = RE_QUOTE.exec(lines[i]))) { q.push(m[1]); i++; }
        var bq = el("blockquote", "dispatch__quote");
        renderBlocks(bq, q.join("\n"));
        parent.appendChild(bq);
        continue;
      }

      if (RE_UL.test(line) || RE_OL.test(line)) {
        flush();
        i = renderList(parent, lines, i);
        continue;
      }

      para.push(line);
      i++;
    }
    flush();
  }

  /* Lists, with nesting by indentation. Returns the next unread line index. */
  function renderList(parent, lines, i) {
    var stack = [];
    while (i < lines.length) {
      var line = lines[i], m, ordered, indent, content;
      if ((m = RE_UL.exec(line))) { ordered = false; indent = m[1].length; content = m[2]; }
      else if ((m = RE_OL.exec(line))) { ordered = true; indent = m[1].length; content = m[3]; }
      else break;

      while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
      var top = stack[stack.length - 1];
      if (!top || indent > top.indent || top.ordered !== ordered) {
        if (top && indent === top.indent) stack.pop();
        var listEl = el(ordered ? "ol" : "ul", "dispatch__list");
        if (ordered && Number(m[2]) > 1) listEl.start = Number(m[2]);
        var host = stack.length ? stack[stack.length - 1].list.lastChild : null;
        (host || parent).appendChild(listEl);
        stack.push({ list: listEl, indent: indent, ordered: ordered });
      }
      var li = el("li");
      appendInline(li, content);
      stack[stack.length - 1].list.appendChild(li);
      i++;
    }
    return i;
  }

  function stripMd(s) {
    return s.replace(/^#{1,3}\s+/, "").replace(/^>\s?/, "")
      .replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/\*(.+?)\*/g, "$1")
      .replace(/~~(.+?)~~/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
  }

  function formatDate(raw) {
    var d = new Date(raw);
    if (!raw || isNaN(d)) return null;
    return {
      iso: d.toISOString(),
      text: d.toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" })
    };
  }

  /* ---------- states ---------- */
  function setState(state, message, withDiscord) {
    root.setAttribute("data-state", state);
    root.setAttribute("aria-busy", state === "loading" ? "true" : "false");
    status.textContent = "";
    status.hidden = !message;
    if (!message) return;
    status.appendChild(el("p", "news-status__msg", message));
    if (withDiscord) {
      var a = el("a", "btn btn--ghost", "Open the Discord announcements");
      a.href = DISCORD;
      a.rel = "noopener";
      a.target = "_blank";
      status.appendChild(a);
    }
  }

  /* ---------- render ---------- */
  function renderPost(post, idx) {
    var content = typeof post.content === "string" ? cleanDiscordTokens(post.content).replace(/\r\n?/g, "\n").trim() : "";
    if (!content) return null;

    var li = el("li", "dispatch");
    var art = el("article", "dispatch__card");
    li.appendChild(art);

    var head = el("header", "dispatch__meta");
    head.appendChild(el("span", "dispatch__no", "Dispatch " + String(idx + 1).padStart(2, "0")));
    var d = formatDate(post.date);
    if (d) {
      var t = el("time", "dispatch__date", d.text);
      t.dateTime = d.iso;
      head.appendChild(t);
    }
    art.appendChild(head);

    /* Drop Discord mention-only lines (e.g. "@everyone") so they never become the headline. */
    content = content.replace(/^(?:\s*@(?:everyone|here)\s*\n)+/i, "").trim();
    if (!content) return null;

    /* First line becomes a heading only for multi-line posts with a short first line. */
    var lines = content.split("\n");
    var first = stripMd(lines[0] || "");
    var body = content;
    if (lines.length > 1 && first.length > 0 && first.length <= 90) {
      art.appendChild(el("h3", "dispatch__title", first));
      body = lines.slice(1).join("\n").replace(/^\n+/, "");
    }

    if (body) {
      var p = el("div", "dispatch__body");
      p.id = "dispatch-body-" + (idx + 1);
      renderBlocks(p, body);
      art.appendChild(p);

      /* Collapse long bodies; updateCollapse() reveals this only if needed. */
      var more = el("button", "dispatch__more", "Read more");
      more.type = "button";
      more.hidden = true;
      more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-controls", p.id);
      more.addEventListener("click", function () {
        var open = art.classList.toggle("is-open");
        more.setAttribute("aria-expanded", open ? "true" : "false");
        more.textContent = open ? "Show less" : "Read more";
        if (!open && art.getBoundingClientRect().top < 0) art.scrollIntoView({ block: "start" });
      });
      art.appendChild(more);
    }

    var foot = el("footer", "dispatch__foot");
    if (typeof post.author === "string" && post.author.trim()) {
      foot.appendChild(el("span", "dispatch__author", "Posted by " + post.author.trim()));
    }
    var link = isDiscordUrl(post.url);
    if (link) {
      var a = el("a", "dispatch__read", "Read on Discord");
      a.href = link;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      var sr = el("span", "visually-hidden", d ? " (dispatch from " + d.text + ", opens in a new tab)" : " (opens in a new tab)");
      a.appendChild(sr);
      foot.appendChild(a);
    }
    if (foot.childNodes.length) art.appendChild(foot);
    return li;
  }

  function render(data) {
    var items = data && Array.isArray(data.news) ? data.news.slice() : null;
    if (!items) throw new Error("Unexpected feed shape");

    items = items.filter(function (p) { return p && typeof p === "object"; });
    items.sort(function (a, b) {
      var ta = new Date(a.date).getTime() || 0, tb = new Date(b.date).getTime() || 0;
      return tb - ta;
    });

    list.textContent = "";
    var shown = 0;
    for (var i = 0; i < items.length && shown < LIMIT; i++) {
      var li = renderPost(items[i], shown);
      if (li) { list.appendChild(li); shown++; }
    }

    if (shown > VISIBLE) {
      var older = el("button", "btn btn--ghost dispatches__older", "Show " + (shown - VISIBLE) + " older dispatch" + (shown - VISIBLE === 1 ? "" : "es"));
      older.type = "button";
      older.setAttribute("aria-expanded", "false");
      older.addEventListener("click", function () {
        list.classList.add("is-all");
        older.setAttribute("aria-expanded", "true");
        older.hidden = true;
        var next = list.children[VISIBLE];
        var btn = next && next.querySelector("a, button");
        if (btn) btn.focus({ preventScroll: true });
      });
      list.parentNode.insertBefore(older, list.nextSibling);
    }
    updateCollapse();

    if (!shown) {
      setState("empty", "No dispatches posted yet. Announcements will appear here as they are posted in the Discord.", true);
    } else {
      setState("ready", "");
    }
  }

  /* Show "Read more" only where the collapsed body actually overflows. */
  function updateCollapse() {
    var cards = list.querySelectorAll(".dispatch__card");
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var body = card.querySelector(".dispatch__body");
      var btn = card.querySelector(".dispatch__more");
      if (!body || !btn || card.classList.contains("is-open")) continue;
      card.classList.add("is-clamped");
      var overflows = body.scrollHeight > body.clientHeight + 2;
      btn.hidden = !overflows;
      if (!overflows) card.classList.remove("is-clamped");
    }
  }
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateCollapse, 150);
  });

  function load() {
    if (!cfg.NEWS_ENDPOINT || !window.fetch) {
      setState("error", "News could not be loaded here. Announcements are posted in the Discord.", true);
      return;
    }
    setState("loading", "Loading dispatches\u2026");

    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, cfg.NEWS_TIMEOUT_MS || 10000) : null;

    fetch(cfg.NEWS_ENDPOINT, {
      method: "GET",
      headers: { "Accept": "application/json" },
      credentials: "omit",
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(render)
      .catch(function (err) {
        if (window.console) console.warn("[Osprey news] feed unavailable:", err && err.message ? err.message : err);
        list.textContent = "";
        setState("error", "The news feed could not be loaded right now. Announcements are always posted in the Discord.", true);
      })
      .then(function () { if (timer) clearTimeout(timer); });
  }

  load();
})();
