/* ==========================================================================
   OSPREY — script.js
   Vanilla JS, no dependencies. Every feature is progressive: the page is
   fully readable and every link works without this file.

   1. Config (change the Discord invite here)
   2. Helpers
   3. Discord links
   4. Wordmark font fallback
   5. Header state
   6. Smooth "Learn more" scroll
   7. Scroll reveals
   8. Button press feedback (keyboard)
   9. Card tilt
   10. The Island (scroll-driven canvas)
   11. Easter egg (wordmark ×5 or Konami code)
   ========================================================================== */
(() => {
  "use strict";

  /* ========================================================================
     1. CONFIG
     ------------------------------------------------------------------------
     Single source of truth for the Discord invite. Every element with
     [data-discord] gets this href at runtime. (The href attributes in
     index.html are only a no-JS fallback.)
     ======================================================================== */
  const CONFIG = {
    discordUrl: "https://discord.gg/4EnjKHUG4S",
    eggClicks: 5,          // wordmark clicks needed for the easter egg
    eggWindowMs: 1800,     // ...within this many milliseconds
  };


  /* ========================================================================
     2. HELPERS
     ======================================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = motionQuery.matches;

  /** Small deterministic PRNG so the island looks the same on every visit. */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  document.documentElement.classList.add("js");


  /* ========================================================================
     3. DISCORD LINKS
     ======================================================================== */
  $$("[data-discord]").forEach((a) => {
    a.href = CONFIG.discordUrl;
    a.target = "_blank";
    a.rel = "noopener";
  });


  /* ========================================================================
     4. WORDMARK FONT FALLBACK
     If Cadass Script can't load (missing file, blocked), switch the wordmark
     to a heavy wide sans so it still reads as a logotype.
     ======================================================================== */
  if (document.fonts) {
    const checkMark = () => {
      const ok = Array.from(document.fonts).some(
        (f) => f.family.replace(/["']/g, "") === "Cadass Script" && f.status === "loaded"
      );
      document.documentElement.classList.toggle("no-markfont", !ok);
    };
    document.fonts.load('400 1em "Cadass Script"', "OSPREY").catch(() => {});
    document.fonts.addEventListener?.("loadingdone", checkMark);
    // Give the font a moment (incl. the file:// embedded copy) before falling back.
    setTimeout(checkMark, 2500);
  }


  /* ========================================================================
     5. HEADER STATE — solid background once the hero is scrolled past.
     ======================================================================== */
  const header = $("[data-header]");
  const hero = $(".hero");
  if (header && hero && "IntersectionObserver" in window) {
    new IntersectionObserver(
      ([entry]) => header.classList.toggle("is-scrolled", !entry.isIntersecting),
      { rootMargin: `-${header.offsetHeight + 40}px 0px 0px 0px`, threshold: 0.35 }
    ).observe(hero);
  }


  /* ========================================================================
     6. SMOOTH "LEARN MORE" SCROLL
     CSS handles smoothing; JS moves keyboard focus to the target so screen
     reader / keyboard users land in the right place.
     ======================================================================== */
  $$("[data-scroll]").forEach((link) => {
    link.addEventListener("click", (e) => {
      const target = $(link.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      history.replaceState(null, "", link.getAttribute("href"));
    });
  });


  /* ========================================================================
     7. SCROLL REVEALS
     ======================================================================== */
  const reveals = $$(".reveal");
  if (reducedMotion || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("is-visible"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 }
    );
    reveals.forEach((el) => io.observe(el));
  }


  /* ========================================================================
     8. BUTTON PRESS FEEDBACK
     :active covers pointer presses; this mirrors it for Enter / Space.
     ======================================================================== */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const btn = e.target.closest && e.target.closest(".btn");
    if (!btn) return;
    btn.classList.add("is-pressed");
    setTimeout(() => btn.classList.remove("is-pressed"), 140);
  });


  /* ========================================================================
     9. CARD TILT — very slight, fine pointers only.
     ======================================================================== */
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (finePointer && !reducedMotion) {
    $$("[data-tilt]").forEach((card) => {
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        card.style.setProperty("--ry", `${(x * 5).toFixed(2)}deg`);
        card.style.setProperty("--rx", `${(-y * 5).toFixed(2)}deg`);
      });
      card.addEventListener("pointerleave", () => {
        card.style.setProperty("--rx", "0deg");
        card.style.setProperty("--ry", "0deg");
      });
    });
  }


  /* ========================================================================
     10. THE ISLAND
     ------------------------------------------------------------------------
     One canvas, drawn in layers back-to-front:
       sky blocks (clouds) → island + reflection → ocean rows → foreground.
     Scroll progress p (0→1) through the tall section drives assembly.
     Some blocks are never built: they appear as faint outlines, and a
     blinking selection outline hovers where the next block would go.
     ======================================================================== */
  const islandSection = $("[data-island]");
  const canvas = $("[data-island-canvas]");
  const steps = $$("[data-island-steps] li");
  const mistLayers = $$("[data-parallax]");

  if (islandSection && canvas && canvas.getContext) {
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, DPR = 1;
    let blocks = [];        // { c, r, v, top, order, built }
    let ghosts = [];        // unbuilt blocks
    let clouds = [];
    let cols = 64, bs = 8, islandLeft = 0;
    let progress = reducedMotion ? 1 : 0;
    let visible = false, rafId = 0, lastStep = -1;

    /** Build the abstract island heightmap. Deterministic, landmark-free. */
    function buildIsland() {
      const rand = mulberry32(7);
      const narrow = W < 640;
      cols = narrow ? 46 : 68;
      const islandWidth = Math.min(W * (narrow ? 0.94 : 0.74), 1180);
      bs = Math.max(4, Math.floor(islandWidth / cols));
      islandLeft = Math.round((W - cols * bs) / 2);
      const maxRows = Math.round(cols * (narrow ? 0.3 : 0.24));

      blocks = [];
      ghosts = [];
      const gauss = (x, m, s) => Math.exp(-((x - m) ** 2) / (2 * s * s));

      for (let c = 0; c < cols; c++) {
        const x = c / (cols - 1);
        // Broad landmass + two soft rises + a little noise, quantized to blocks.
        let h =
          Math.pow(Math.sin(Math.PI * x), 0.7) * 0.32 +
          gauss(x, 0.36, 0.11) * 0.68 +
          gauss(x, 0.66, 0.08) * 0.42 +
          (rand() - 0.5) * 0.08;
        h = Math.max(0, Math.round(h * maxRows));
        if (x < 0.03 || x > 0.97) h = Math.min(h, 1);

        for (let r = 0; r < h; r++) {
          const top = r === h - 1;
          const v = top ? 118 + rand() * 30 : 34 + r * 2.2 + rand() * 12;
          // Bottom-up assembly with a bit of jitter so it feels placed by hand.
          const order = r + rand() * 2.2 + x * 0.6;
          // Intentionally unfinished: the far edge and scattered upper blocks stay unbuilt.
          const unfinished = (x > 0.79 && rand() < 0.82) || (r > 3 && rand() < 0.1) || (top && x > 0.55 && x < 0.62);
          const b = { c, r, v, top, order };
          (unfinished ? ghosts : blocks).push(b);
        }
      }

      blocks.sort((a, b) => a.order - b.order);
      blocks.forEach((b, i) => (b.rank = i / Math.max(1, blocks.length - 1)));
      // Ghosts nearest the built mass first, for the selection cursor.
      ghosts.sort((a, b) => a.c - b.c || a.r - b.r);

      // Flat, blocky cloud banks in the sky.
      const crand = mulberry32(21);
      clouds = Array.from({ length: narrow ? 4 : 7 }, () => ({
        x: crand() * W,
        y: H * (0.12 + crand() * 0.3),
        w: (4 + Math.floor(crand() * 8)) * bs * 2,
        h: bs * (1 + Math.floor(crand() * 2)),
        a: 0.025 + crand() * 0.035,
        s: 0.15 + crand() * 0.35,
        depth: 0.3 + crand() * 0.7,
      }));
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, Math.round(rect.width));
      H = Math.max(1, Math.round(rect.height));
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.imageSmoothingEnabled = false;
      buildIsland();
      draw(performance.now());
    }

    function readProgress() {
      if (reducedMotion) return 1;
      const rect = islandSection.getBoundingClientRect();
      const total = islandSection.offsetHeight - window.innerHeight;
      return total > 0 ? clamp(-rect.top / total) : 1;
    }

    function updateSteps(p) {
      const idx = p < 0.16 ? 0 : p < 0.46 ? 1 : p < 0.74 ? 2 : 3;
      if (idx === lastStep) return;
      lastStep = idx;
      steps.forEach((li, i) => li.classList.toggle("is-active", i === idx));
    }

    const gray = (v, a = 1) => `rgba(${v | 0},${v | 0},${v | 0},${a})`;
    // Accent colours (match --sea / --violet / --moss in styles.css).
    const sea = (a) => `rgba(92,198,214,${a})`;
    const violet = (a) => `rgba(165,139,255,${a})`;
    const moss = (a) => `rgba(127,209,143,${a})`;

    function draw(now) {
      const p = progress;
      const t = reducedMotion ? 0 : now / 1000;
      const horizon = Math.round(H * 0.62);

      ctx.clearRect(0, 0, W, H);

      /* --- Layer 1: cloud banks (slowest parallax) --------------------- */
      for (const cl of clouds) {
        const x = ((cl.x + t * cl.s * 12) % (W + cl.w * 2)) - cl.w;
        const y = cl.y + (1 - p) * 30 * cl.depth;
        ctx.fillStyle = gray(255, cl.a);
        ctx.fillRect(Math.round(x), Math.round(y), cl.w, cl.h);
        ctx.fillRect(Math.round(x + cl.w * 0.2), Math.round(y - cl.h), Math.round(cl.w * 0.45), cl.h);
      }

      /* --- Horizon glow ------------------------------------------------ */
      const glow = ctx.createLinearGradient(0, horizon - H * 0.18, 0, horizon + 2);
      glow.addColorStop(0, "rgba(255,255,255,0)");
      glow.addColorStop(1, `rgba(255,255,255,${0.035 + p * 0.03})`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, horizon - H * 0.18, W, H * 0.18 + 2);

      /* --- Layer 2: island (rises gently toward the horizon) ----------- */
      const islandShift = Math.round((1 - p) * H * 0.05);
      const base = horizon + islandShift; // waterline for the island layer
      const start = 0.16, span = 0.56;     // assembly window within p
      const gap = bs >= 7 ? 1 : 0.5;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, horizon);          // island never draws below the waterline
      ctx.clip();
      for (const b of blocks) {
        const a = clamp((p - (start + b.rank * span)) / 0.035);
        if (a <= 0) continue;
        const e = easeOut(a);
        const x = islandLeft + b.c * bs;
        const y = base - (b.r + 1) * bs - (1 - e) * bs * 5;
        ctx.fillStyle = gray(b.v, e);
        ctx.fillRect(x, Math.round(y), bs - gap, bs - gap);
        if (b.top) {
          ctx.fillStyle = moss(0.45 * e);
          ctx.fillRect(x, Math.round(y), bs - gap, Math.max(1, bs * 0.22));
        }
      }

      /* --- Unbuilt blocks: outlines + a blinking "selection" cursor ---- */
      const ghostA = clamp((p - 0.7) / 0.15);
      if (ghostA > 0) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = violet(0.22 * ghostA);
        for (const g of ghosts) {
          ctx.strokeRect(islandLeft + g.c * bs + 0.5, base - (g.r + 1) * bs + 0.5, bs - 1 - gap, bs - 1 - gap);
        }
        if (ghosts.length) {
          // Cursor steps through the unbuilt blocks over time.
          const gi = Math.floor(t / 1.6) % ghosts.length;
          const g = ghosts[(gi * 7) % ghosts.length];
          const blink = reducedMotion ? 1 : 0.55 + 0.45 * Math.sin(t * 5);
          ctx.lineWidth = Math.max(1, bs * 0.14);
          ctx.strokeStyle = violet(0.95 * ghostA * blink);
          ctx.strokeRect(islandLeft + g.c * bs, base - (g.r + 1) * bs, bs - gap, bs - gap);
        }
      }
      ctx.restore();

      /* --- Horizon line ----------------------------------------------- */
      ctx.fillStyle = sea(0.28);
      ctx.fillRect(0, horizon, W, 1);

      /* --- Layer 3: reflection + ocean rows ---------------------------- */
      // Reflection: built blocks mirrored and squashed, broken by waves.
      for (const b of blocks) {
        const a = clamp((p - (start + b.rank * span)) / 0.035);
        if (a <= 0 || b.r > 8) continue;
        const ry = horizon + 2 + b.r * bs * 0.55;
        const wob = reducedMotion ? 0 : Math.sin(t * 1.4 + b.r * 1.3 + b.c * 0.2) * bs * 0.4;
        ctx.fillStyle = gray(b.v, 0.12 * a * (1 - b.r / 9));
        ctx.fillRect(islandLeft + b.c * bs + wob, ry, bs - gap, Math.max(1, bs * 0.45));
      }

      // Ocean: perspective rows of block-dashes; rows near the viewer move faster.
      const rows = 22;
      for (let i = 0; i < rows; i++) {
        const d = i / (rows - 1);                  // 0 = horizon, 1 = near
        const y = horizon + 3 + Math.pow(d, 1.7) * (H - horizon);
        const size = lerp(1.5, Math.max(6, bs * 1.4), d);
        const step = size * lerp(9, 5, d);
        const speed = lerp(4, 26, d);
        const off = (t * speed + p * 160 * d + i * 37) % step;
        const alpha = lerp(0.05, 0.13, d) * (0.6 + 0.4 * Math.sin(i * 2.1));
        // Rows alternate between gray and a faint sea tint.
        ctx.fillStyle = i % 2 === 1 ? sea(alpha * 1.6) : gray(255, alpha);
        for (let x = -step + off; x < W + step; x += step) {
          const len = size * (1.4 + (((x / step) | 0) % 3) * 0.7);
          ctx.fillRect(Math.round(x), Math.round(y), Math.round(len), Math.max(1, Math.round(size * 0.3)));
        }
      }

      /* --- Layer 4: foreground block swell (fastest parallax) ---------- */
      const fgBase = H + 6 - p * H * 0.06;
      const fbs = Math.max(14, bs * 3);
      ctx.fillStyle = "#050505";
      const fgOff = (t * 10) % (fbs * 2);
      for (let x = -fbs * 2 + fgOff, k = 0; x < W + fbs * 2; x += fbs, k++) {
        const h = fbs * (1 + ((k * 7) % 5 === 0 ? 1 : 0) + ((k * 3) % 4 === 0 ? 0.5 : 0));
        ctx.fillRect(Math.round(x), Math.round(fgBase - h), fbs + 1, h + 10);
      }
      ctx.fillStyle = sea(0.1);
      for (let x = -fbs * 2 + fgOff, k = 0; x < W + fbs * 2; x += fbs, k++) {
        const h = fbs * (1 + ((k * 7) % 5 === 0 ? 1 : 0) + ((k * 3) % 4 === 0 ? 0.5 : 0));
        ctx.fillRect(Math.round(x), Math.round(fgBase - h), fbs, 1);
      }
    }

    function frame(now) {
      rafId = 0;
      progress = readProgress();
      islandSection.style.setProperty("--p", progress.toFixed(3));
      mistLayers.forEach((el) => {
        const f = parseFloat(el.dataset.parallax) || 0.3;
        el.style.setProperty("--shift", `${((0.5 - progress) * 90 * f).toFixed(1)}px`);
      });
      updateSteps(progress);
      draw(now);
      if (visible && !reducedMotion) rafId = requestAnimationFrame(frame);
    }

    function start() {
      if (!rafId) rafId = requestAnimationFrame(frame);
    }

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (visible) start();
      }).observe(islandSection);
    } else {
      visible = true;
      start();
    }

    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 120);
    });

    // React if the user toggles reduced motion while the page is open.
    motionQuery.addEventListener?.("change", (e) => {
      reducedMotion = e.matches;
      progress = readProgress();
      resize();
      updateSteps(progress);
      start();
    });

    resize();
    updateSteps(readProgress());
    start();
  }


  /* ========================================================================
     11. EASTER EGG
     ------------------------------------------------------------------------
     Click the OSPREY wordmark 5× quickly, or enter the Konami code:
     a small flock of block-birds crosses the screen. The overlay is
     aria-hidden and pointer-events: none, so it never blocks anything.
     ======================================================================== */
  const flight = $("[data-flight]");
  const wordmark = $("[data-wordmark]");
  let flying = false;

  const BIRD_FRAMES = [
    // wings up
    ["X.......X", "XX.....XX", ".XX.X.XX.", "...XXX...", "....X...."],
    // wings down
    [".........", "....X....", ".XXXXXXX.", "XX.XXX.XX", "X...X...X"],
  ];

  function makeBird({ y, px, delay, dur }) {
    const bird = document.createElement("div");
    bird.className = "flight__bird";
    bird.style.setProperty("--y", y);
    bird.style.setProperty("--px", `${px}px`);
    bird.style.setProperty("--delay", `${delay}s`);
    bird.style.setProperty("--dur-fly", `${dur}s`);
    BIRD_FRAMES.forEach((frame) => {
      const i = document.createElement("i");
      frame.join("").split("").forEach((ch) => {
        const b = document.createElement("b");
        if (ch !== "X") b.style.background = "transparent";
        i.appendChild(b);
      });
      bird.appendChild(i);
    });
    return bird;
  }

  function launchFlock() {
    if (!flight || flying) return;
    flying = true;

    if (reducedMotion) {
      // Calm version: a single still bird appears briefly beside the wordmark.
      const bird = makeBird({ y: "22%", px: 6, delay: 0, dur: 0 });
      bird.style.animation = "none";
      bird.style.left = "50%";
      bird.style.transform = "translateX(-50%)";
      flight.appendChild(bird);
      setTimeout(() => { bird.remove(); flying = false; }, 1400);
      return;
    }

    const flock = [
      { y: "30%", px: 6, delay: 0, dur: 3.4 },
      { y: "24%", px: 4, delay: 0.25, dur: 3.8 },
      { y: "36%", px: 4, delay: 0.4, dur: 3.6 },
      { y: "19%", px: 3, delay: 0.6, dur: 4.2 },
      { y: "41%", px: 3, delay: 0.75, dur: 4.0 },
    ].map(makeBird);

    flock.forEach((b) => flight.appendChild(b));
    const longest = 4.2 + 0.75;
    setTimeout(() => {
      flock.forEach((b) => b.remove());
      flying = false;
    }, longest * 1000 + 100);
  }

  // Wordmark clicks
  if (wordmark) {
    let clicks = [];
    wordmark.addEventListener("click", () => {
      const now = performance.now();
      clicks = clicks.filter((ts) => now - ts < CONFIG.eggWindowMs);
      clicks.push(now);
      wordmark.classList.add("is-tapped");
      setTimeout(() => wordmark.classList.remove("is-tapped"), 90);
      if (clicks.length >= CONFIG.eggClicks) {
        clicks = [];
        launchFlock();
      }
    });
  }

  // Konami code: ↑ ↑ ↓ ↓ ← → ← → B A
  const KONAMI = ["arrowup", "arrowup", "arrowdown", "arrowdown", "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a"];
  let kIndex = 0;
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable) return;
    const key = (e.key || "").toLowerCase();
    if (key === KONAMI[kIndex]) {
      kIndex++;
      if (kIndex === KONAMI.length) {
        kIndex = 0;
        launchFlock();
      }
    } else {
      kIndex = key === KONAMI[0] ? 1 : 0;
    }
  });
})();
