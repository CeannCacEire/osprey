/* Osprey landing page: "What is Osprey?" dialog and copy buttons.
   The page works without JS: the dialog link falls back to the wiki. */
(function () {
  "use strict";

  /* ---------- Dialog ---------- */
  var dialog = document.getElementById("what-is-osprey");
  var openers = document.querySelectorAll("[data-open-about]");
  var supported = dialog && typeof dialog.showModal === "function";

  function open() {
    if (!dialog.open) dialog.showModal();
    if (location.hash !== "#what-is-osprey") history.replaceState(null, "", "#what-is-osprey");
  }
  function close() { if (dialog.open) dialog.close(); }

  if (!supported) {
    openers.forEach(function (a) { a.href = "wiki/getting-started/what-is-osprey/"; });
  } else {
    openers.forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); open(); });
    });
    dialog.querySelectorAll("[data-close-about]").forEach(function (b) {
      b.addEventListener("click", close);
    });
    /* Click on the backdrop closes the dialog. */
    dialog.addEventListener("click", function (e) { if (e.target === dialog) close(); });
    dialog.addEventListener("close", function () {
      if (location.hash === "#what-is-osprey") history.replaceState(null, "", location.pathname + location.search);
    });
    if (location.hash === "#what-is-osprey") open();
  }

  /* ---------- Copy buttons ---------- */
  var live = document.querySelector("[data-copy-live]");
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    var verb = btn.firstChild;
    var timer;
    btn.hidden = false;
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      copyText(text).then(function (ok) {
        clearTimeout(timer);
        btn.setAttribute("data-state", ok ? "ok" : "fail");
        verb.nodeValue = ok ? "Copied" : "Failed";
        if (live) { live.textContent = ""; setTimeout(function () { live.textContent = ok ? text + " copied" : "Could not copy " + text; }, 30); }
        timer = setTimeout(function () { btn.removeAttribute("data-state"); verb.nodeValue = "Copy"; }, 2000);
      });
    });
  });

  /* ---------- Screenshot carousel ---------- */
  (function () {
    var root = document.querySelector(".shots");
    if (!root) return;
    var slides = root.querySelectorAll(".shots__slide");
    if (slides.length < 2) return;
    var dotsWrap = root.querySelector("[data-shots-dots]");
    var prev = root.querySelector("[data-shots-prev]");
    var next = root.querySelector("[data-shots-next]");
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var DELAY = 5000;
    var index = 0, timer = null, paused = false, dots = [];

    slides.forEach(function (_, i) {
      var d = document.createElement("button");
      d.type = "button"; d.className = "shots__dot";
      d.setAttribute("aria-label", "Show screenshot " + (i + 1));
      d.addEventListener("click", function () { go(i); restart(); });
      dotsWrap.appendChild(d); dots.push(d);
    });

    function go(i) {
      index = (i + slides.length) % slides.length;
      slides.forEach(function (s, n) {
        var on = n === index;
        s.classList.toggle("is-active", on);
        if (on) s.removeAttribute("aria-hidden"); else s.setAttribute("aria-hidden", "true");
      });
      dots.forEach(function (d, n) {
        if (n === index) d.setAttribute("aria-current", "true"); else d.removeAttribute("aria-current");
      });
      /* Warm the next image so the fade never shows a blank frame. */
      var upcoming = slides[(index + 1) % slides.length].querySelector("img");
      if (upcoming && upcoming.loading === "lazy") upcoming.loading = "eager";
    }
    function stop() { clearInterval(timer); timer = null; }
    function start() {
      if (reduce || paused || document.hidden || timer) return;
      timer = setInterval(function () { go(index + 1); }, DELAY);
    }
    function restart() { stop(); start(); }

    prev.addEventListener("click", function () { go(index - 1); restart(); });
    next.addEventListener("click", function () { go(index + 1); restart(); });
    root.addEventListener("mouseenter", function () { paused = true; stop(); });
    root.addEventListener("mouseleave", function () { paused = false; start(); });
    root.addEventListener("focusin", function () { paused = true; stop(); });
    root.addEventListener("focusout", function (e) {
      if (!root.contains(e.relatedTarget)) { paused = false; start(); }
    });
    root.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { go(index - 1); e.preventDefault(); }
      if (e.key === "ArrowRight") { go(index + 1); e.preventDefault(); }
    });
    /* Swipe on touch screens. */
    var x0 = null;
    root.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    root.addEventListener("touchend", function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 40) { go(index + (dx < 0 ? 1 : -1)); restart(); }
    }, { passive: true });
    document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });

    prev.hidden = next.hidden = dotsWrap.hidden = false;
    go(0); start();
  })();
})();
