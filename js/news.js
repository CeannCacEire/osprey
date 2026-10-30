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
   - The only formatting supported is **bold** (Discord markdown), built as
     <strong> elements, not markup strings.
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

  /* Append text with restricted links into parent. */
  var URL_RE = /https?:\/\/[^\s<>"'`]+/g;
  function appendLinked(parent, text) {
    var last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      var raw = m[0].replace(/[).,!?:;]+$/, ""); /* trailing punctuation */
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var href = safeHttpUrl(raw);
      if (href) {
        var a = el("a", "dispatch__link", raw);
        a.href = href;
        a.rel = "noopener noreferrer nofollow";
        a.target = "_blank";
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(raw));
      }
      last = m.index + raw.length;
      URL_RE.lastIndex = last;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  /* Append text, supporting **bold** only, then links inside each run. */
  function appendFormatted(parent, text) {
    var parts = text.split(/\*\*(.+?)\*\*/g);
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2 === 1) {
        var b = el("strong");
        appendLinked(b, parts[i]);
        parent.appendChild(b);
      } else {
        appendLinked(parent, parts[i]);
      }
    }
  }

  function stripMd(s) {
    return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,3}\s+/, "").replace(/^>\s?/, "").trim();
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

    /* First line becomes a heading only for multi-line posts with a short first line. */
    var lines = content.split("\n");
    var first = stripMd(lines[0] || "");
    var body = content;
    if (lines.length > 1 && first.length > 0 && first.length <= 90) {
      art.appendChild(el("h3", "dispatch__title", first));
      body = lines.slice(1).join("\n").replace(/^\n+/, "");
    }

    if (body) {
      var p = el("p", "dispatch__body");
      appendFormatted(p, body);
      art.appendChild(p);
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

    if (!shown) {
      setState("empty", "No dispatches posted yet. Announcements will appear here as they are posted in the Discord.", true);
    } else {
      setState("ready", "");
    }
  }

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
        setState("error", "Dispatches could not be loaded right now. Announcements are always posted in the Discord.", true);
      })
      .then(function () { if (timer) clearTimeout(timer); });
  }

  load();
})();
