# OSPREY — landing page

Static, dependency-free. Open `index.html` directly or upload the folder to any static host.

## Files
- `index.html` — markup, SEO / Open Graph / Twitter metadata
- `styles.css` — all styles, organized by section
- `script.js` — interactions (island canvas, reveals, place-a-block, easter egg)
- `fonts/Cadass Script Demo.ttf` — wordmark font (hero only)
- `fonts/archivo-latin.woff2` — body font (Archivo, SIL OFL)
- `fonts/fonts-local.js` — embedded font copies, loaded only when opened via `file://`
- `favicon.svg`, `og-image.png`

## Change the Discord invite
Edit `CONFIG.discordUrl` at the top of `script.js`. The `href`s in `index.html` are a no-JS fallback; find-and-replace them too if you want both in sync.

## Before going public
- **Font license:** Cadass Script is "free for personal use" on DaFont. Get a commercial/public license from the author (subqi.com) or swap the font.
- **Domain:** update `canonical`, `og:url`, `og:image`, `twitter:image` in `index.html` if the site moves off `https://ceanncaceire.github.io/osprey/` (e.g. to a custom domain).

## Easter egg
Click the OSPREY wordmark 5 times quickly, or enter ↑ ↑ ↓ ↓ ← → ← → B A.
