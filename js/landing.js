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
})();
