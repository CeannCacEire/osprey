# Osprey website

Static two-page site for **Osprey**, an upcoming cross-compatible Vanilla+ Minecraft server built on Osprey Core. It's hosted on GitHub Pages at **https://osprey.build**.

The design is an "Osprey field manual": oversized poster type, numbered chapters, Minecraft-style inventory slots, item plates and a dispatch noticeboard. The palette is black, charcoal, grey and off-white, with teal (Vigil), lavender (Crystal) and a Nether red reserved for Banishment. **No yellow or gold is used anywhere**, and the artwork was recoloured to match (see "Processed artwork" below).

## Structure

```
/
├── index.html              Main page (hero, 01–05 chapters, footer)
├── in-depth/index.html     "See Osprey in Depth" field guide (11 entries, 5 chapters)
├── css/main.css            Shared stylesheet, sectioned 00–17
├── js/config.js            Central config: Discord URL, server details, News endpoint, Live World embed URL
├── js/main.js              Copy buttons, Live World mount point, reveal-on-scroll, footer year
├── js/news.js              Dispatches (News) feed: fetch, safe rendering, loading/empty/error states
├── fonts/                  Web fonts actually used by the site (+ licence texts)
│   └── source/             Untouched original font files as supplied/downloaded
├── assets/
│   ├── items/              Processed item art used by the pages
│   ├── brand/              Emblem (light/dark), favicon, apple-touch-icon, og-image.png
│   ├── world/              Processed island map (320/480/640/900 px) used in Core Pillars
│   └── originals/          Untouched supplied assets (items, brand, text). Not referenced by pages.
├── CNAME                   Custom domain (osprey.build). Do not remove.
└── .nojekyll               Serve files as-is on GitHub Pages
```

Both pages use relative paths only (`css/…` on the home page, `../css/…` on `/in-depth/`), so each page works when opened directly at `https://osprey.build/` or `https://osprey.build/in-depth/`. There's no SPA routing and no build step.

## Deploying on GitHub Pages

1. Push the repository contents to the `main` branch of `CeannCacEire/osprey`.
2. In **Settings → Pages**, the source stays as "Deploy from a branch → `main` / root" and the custom domain stays as `osprey.build` (kept in `CNAME`). No DNS changes are needed.
3. Pages republishes automatically within a minute or two.

To preview locally, run `python3 -m http.server 8000` in the repo root, then open `http://localhost:8000/`. Opening the HTML straight from disk (`file://`) works for layout, but browsers may block the font files and the News feed there.

## Font roles

| Role | Font | File | Notes |
|---|---|---|---|
| Wordmark only | Cadass Script Demo | `fonts/cadass-script-demo.ttf` | Used only by `.wordmark`. Always typed as "Osprey", with `text-transform: none` and `font-variant: normal` forced. |
| Headings, buttons, navigation | Cinzel (variable, weights 400–900) | `fonts/cinzel-variable.woff2` | Latin subset of the official OFL variable font. Headings are uppercase. |
| Body text, descriptions, announcements, UI labels | Geist Pixel Regular | `fonts/geist-pixel-regular.woff2` | Static "Regular" instance of the official variable font (ELSH = 0), Latin subset. Only weight 400 exists, so `font-synthesis: none` is set and no fake bold or italic is generated. |

All fonts use `@font-face` with `font-display` (the wordmark uses `block`, the others `swap`) and system fallbacks.

## News (Dispatches) feed

- **Endpoint:** `NEWS_ENDPOINT` in `js/config.js` (currently `https://osprey-news.genocchi.workers.dev/api/news`, an absolute URL).
- **Expected shape:** `{ "news": [ { "id", "date", "author", "content", "url" } ] }`.
- `js/news.js` sorts the posts newest first and shows up to `NEWS_LIMIT` (5).
- **Rendering is text-only:** feed content goes into the page via `textContent` and text nodes, never `innerHTML`.
  - Line breaks are preserved.
  - `**bold**` is the only formatting supported.
  - Bare `http(s)` URLs become links after validation with `URL()`.
  - Discord mention tokens become `@member`, `#channel`, `@role` and `:emoji:`.
  - A short first line of a multi-line post becomes the heading and is not repeated in the body.
  - "Read on Discord" appears only for `https://discord.com` (and the ptb, canary and `discordapp.com` variants).
- **States:** loading (`aria-busy`, polite live region), empty, and error. The error and empty states both link to the Discord, and a `<noscript>` message covers no-JS visitors. A failed feed never affects the rest of the page.
- **CORS:** the Worker only sends `Access-Control-Allow-Origin: https://osprey.build`. On any other origin (localhost, preview hosts, `file://`) the browser blocks the response and the board shows its error state. That's expected and not a site bug. Don't switch to `mode: "no-cors"`: the response would be unreadable.

## Live World placeholder → real dashboard

The Live World bay on the home page (`#live-world`) is a reusable container:

- `[data-live-world-screen]` reserves the space (16:9 on desktop, 4:5 on phones), so nothing shifts when the embed arrives.
- `[data-live-world-placeholder]` holds the "coming soon" copy and is separate from the screen.

**To activate it:** set `LIVE_WORLD_EMBED_URL` in `js/config.js` to the dashboard's real `https://` embed URL. `mountLiveWorld()` in `js/main.js` then:

1. hides the placeholder;
2. inserts a lazy-loaded, sandboxed `<iframe>`;
3. sets the bay's state to `live`.

Adjust the `sandbox` attributes to whatever the dashboard needs. If the dashboard isn't iframe-based (for example, a script widget), replace the body of `mountLiveWorld()` instead.

While the value is `""`, no iframe or other request is made.

## Processed artwork

The originals are kept unchanged in `assets/originals/`. The processed copies in `assets/items/` are:

| File | What changed |
|---|---|
| `crystal.webp` / `crystal-still.png` | Yellow centre and glow recoloured to a cool white; the lavender is kept. Every 5th frame is kept (1650 → 330 frames, same loop speed) to cut the size from several MB to about 360 KB. |
| `ledger-chest.webp`, `standard.webp`, `shop-barrel.png`, `ledger-book.png` | Golden oak tones shifted to a darker, redder spruce-like brown. The animations are saved losslessly so compression doesn't reintroduce yellow pixels. The Standard keeps every 2nd frame. |
| `*-still.png` | First frames, used for `prefers-reduced-motion`. |
| `lookout`, `jukebox-lookout`, `shop-barrel` | Semi-transparent edge pixels neutralised and warm wood tones nudged slightly redder, so they stay non-yellow when composited on the light plate background. |
| `vigil`, `feather`, `warden` | Copied unchanged (no gold present). |
| `assets/world/island-map-*.webp` | From the supplied `map.png` (original in `assets/originals/world/`). The map viewer's zoom toolbar was cropped off; desert/sand tones were shifted (warm sand → terracotta, pale sand → cool stone, olive → green) and each size was pre-scaled and palette-quantised so no yellow survives. |
| `assets/brand/osprey-mark-*.png` | The supplied `serverlogo.webp` cropped, with the white background removed (light and dark versions). |
| `favicon.png`, `apple-touch-icon.png`, `og-image.png` | Generated from the emblem and wordmark. The social card carries the tagline "A player-led civilization". |

An automated pixel scan finds no yellow or gold pixels in any processed asset or in full-page renders of either page (1×, 2× and 3× pixel density). Item art and the map use `image-rendering: pixelated`, because smooth browser resampling blends neighbouring colours into yellowish in-between tones.

Backgrounds use a fine monochrome grain and soft tonal light rather than graph-paper grids.

## Outstanding questions

1. **Mate Shield artwork is missing.** Entry No. 04 shows an honest "Artwork not yet supplied" plate. Add `assets/items/mate-shield.png` and swap the plate markup in `in-depth/index.html`.
2. **Cadass Script licence.** The supplied file is "Cadass Script **Demo**", which DaFont lists as free for personal use. Confirm a licence that covers a public website with the font's author before relying on it long-term.
3. **Cinzel and Geist Pixel** are SIL Open Font License fonts from the official Google Fonts repository. The licence texts are in `fonts/`.
4. **Minecraft-derived textures.** Several item renders appear to be based on vanilla Minecraft textures. Fine for a fan server, but noted for completeness.
5. **Copy edits.**
   - Light typo fixes were applied to the supplied text:
     - "infastructure" → "infrastructure"
     - "Ospreys" → "Osprey's"
     - "wont" → "won't"
     - "Its" → "It's"
     - "Osprey-core"/"Osprey-Core" → "Osprey Core"
   - British spelling ("civilisation", "monopolise") is used throughout to match `items.txt`.
   - The meaning of every sentence is unchanged.
6. **Core Pillars.** The supplied `Core-Pillars.txt` has three pillars: Finite Resources, Player Choice and No Learning Curve. All three are used, with only the light edits listed above (for example, "you would require several commands to utilize" became "would require several commands to use"). The 11 field guide entries use the text of `items.txt` exactly.
