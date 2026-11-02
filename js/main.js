/* =========================================================================
   Osprey: shared page behaviour (both pages)
   - Copy-to-clipboard buttons with visible + announced feedback
   - Live World bay: mounts the future dashboard embed when configured
   - Gentle reveal-on-scroll (progressive enhancement only)
   Everything here is optional: the pages are fully readable without JS.
   ========================================================================= */
(function () {
  "use strict";

  var cfg = window.OSPREY_CONFIG || {};
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Copy buttons ----------------------------------------------
     <button data-copy="text to copy" data-copy-label="Java address">
     Feedback goes into the shared live region [data-copy-live] and into the
     button's own .copy__state text for sighted users. */
  var live = document.querySelector("[data-copy-live]");

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  function announce(msg) {
    if (!live) return;
    live.textContent = "";
    /* Re-set on the next frame so repeat copies are announced again. */
    setTimeout(function () { live.textContent = msg; }, 30);
  }

  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    var stateEl = btn.querySelector(".copy__state");
    var idle = stateEl ? stateEl.textContent : "";
    var timer;
    btn.hidden = false;
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var label = btn.getAttribute("data-copy-label") || "Text";
      copyText(text).then(function (ok) {
        clearTimeout(timer);
        btn.setAttribute("data-copy-state", ok ? "ok" : "fail");
        if (stateEl) stateEl.textContent = ok ? "Copied" : "Copy failed";
        announce(ok
          ? label + " copied: " + text
          : "Could not copy. " + label + " is " + text + ". Select it and copy manually.");
        if (!ok) {
          /* Select the visible value so manual copying is one keystroke away. */
          var target = document.getElementById(btn.getAttribute("aria-describedby") || "");
          if (target && window.getSelection) {
            var r = document.createRange();
            r.selectNodeContents(target);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
          }
        }
        timer = setTimeout(function () {
          btn.removeAttribute("data-copy-state");
          if (stateEl) stateEl.textContent = idle;
        }, ok ? 2200 : 5000);
      });
    });
  });

  /* ---------- Live World bay --------------------------------------------
     https URL  -> sandboxed iframe embed.
     http URL   -> "map online" state with a button that opens it in a new
                   tab (an http page can't be framed inside the https site).
     empty      -> static "coming soon" placeholder stays as-is. */
  function mountLiveWorld() {
    var bay = document.querySelector("[data-live-world]");
    if (!bay) return;
    var raw = (cfg.LIVE_WORLD_EMBED_URL || "").trim();
    if (!raw) return;
    var u;
    try { u = new URL(raw); } catch (e) { return; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return;

    var screen = bay.querySelector("[data-live-world-screen]");
    var placeholder = bay.querySelector("[data-live-world-placeholder]");
    var status = bay.querySelector("[data-live-world-status]");
    var canFrame = u.protocol === "https:" || location.protocol === "http:";

    if (canFrame) {
      var frame = document.createElement("iframe");
      frame.src = u.href;
      frame.title = cfg.LIVE_WORLD_EMBED_TITLE || "Falcon live world map";
      frame.loading = "lazy";
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups");
      frame.className = "bay__frame";
      if (placeholder) placeholder.hidden = true;
      screen.appendChild(frame);
      bay.setAttribute("data-state", "live");
      if (status) status.lastChild.textContent = "Live map";
      return;
    }

    /* Link-out mode */
    bay.setAttribute("data-state", "link");
    if (status) status.lastChild.textContent = "Live map online";
    if (placeholder) {
      var line = placeholder.querySelector(".bay__line");
      var sub = placeholder.querySelector(".bay__sub");
      if (line) line.textContent = "The live map is online.";
      if (sub) sub.textContent = "Explore the island, its bases and who's on, in real time.";
      var a = document.createElement("a");
      a.className = "btn btn--outline btn--lg bay__cta";
      a.href = u.href;
      a.target = "_blank";
      a.rel = "noopener";
      a.innerHTML = 'Open the live map<span class="visually-hidden"> (opens in a new tab)</span>';
      placeholder.appendChild(a);
    }
  }
  mountLiveWorld();

  /* ---------- Reveal on scroll ------------------------------------------
     Content is visible by default (CSS only hides [data-reveal] once the
     html element has .reveal-ready). Skipped entirely for reduced motion. */
  var revealables = document.querySelectorAll("[data-reveal]");
  if (!reduceMotion && "IntersectionObserver" in window && revealables.length) {
    document.documentElement.classList.add("reveal-ready");
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    revealables.forEach(function (n) {
      /* Anything already on screen shows immediately. */
      var r = n.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) n.classList.add("is-in");
      else io.observe(n);
    });
  }

  /* ---------- Footer year ---------- */
  document.querySelectorAll("[data-year]").forEach(function (n) {
    n.textContent = String(new Date().getFullYear());
  });
})();
