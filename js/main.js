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
     Only acts when OSPREY_CONFIG.LIVE_WORLD_EMBED_URL is a real https URL.
     Until then the static placeholder in the HTML stays as-is and nothing
     is loaded. */
  function mountLiveWorld() {
    var bay = document.querySelector("[data-live-world]");
    if (!bay) return;
    var raw = (cfg.LIVE_WORLD_EMBED_URL || "").trim();
    if (!raw) return;
    var href;
    try {
      var u = new URL(raw);
      if (u.protocol !== "https:") return;
      href = u.href;
    } catch (e) { return; }

    var screen = bay.querySelector("[data-live-world-screen]");
    var placeholder = bay.querySelector("[data-live-world-placeholder]");
    var frame = document.createElement("iframe");
    frame.src = href;
    frame.title = cfg.LIVE_WORLD_EMBED_TITLE || "Osprey Core live world dashboard";
    frame.loading = "lazy";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    /* Adjust sandbox permissions to what the real dashboard needs. */
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups");
    frame.className = "bay__frame";
    if (placeholder) placeholder.hidden = true;
    screen.appendChild(frame);
    bay.setAttribute("data-state", "live");
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
