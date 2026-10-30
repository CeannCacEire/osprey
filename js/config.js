/* =========================================================================
   Osprey: central site configuration
   -------------------------------------------------------------------------
   Edit values here, not in main.js or news.js. Every page loads this file
   first. Do not put secrets or tokens here: it is a public static file.
   ========================================================================= */
window.OSPREY_CONFIG = Object.freeze({
  /* Canonical production origin (GitHub Pages custom domain, see CNAME). */
  SITE_ORIGIN: "https://osprey.build",

  /* Official Discord invite, used on every Discord link. */
  DISCORD_URL: "https://discord.gg/4EnjKHUG4S",

  /* Server connection details. No Java port is published (the default applies). */
  SERVER: Object.freeze({
    JAVA_ADDRESS: "play.osprey.build",
    BEDROCK_ADDRESS: "play.osprey.build",
    BEDROCK_PORT: "19132"
  }),

  /* News feed (Cloudflare Worker that relays the Discord announcements channel).
     Must stay an absolute URL. Expected response: { "news": [ { id, date, author, content, url } ] }
     The Worker only allows CORS from https://osprey.build, so on any other origin
     (local preview, file://) the feed shows its error state. That is expected. */
  NEWS_ENDPOINT: "https://osprey-news.genocchi.workers.dev/api/news",
  NEWS_LIMIT: 5,
  NEWS_TIMEOUT_MS: 10000,

  /* Live World / Osprey Core dashboard embed.
     -----------------------------------------------------------------------
     Leave this as "" until the real dashboard exists. While it is empty, the
     Live World bay shows its "coming soon" placeholder and NO iframe loads.
     When the dashboard is live, set the full https:// URL of its embeddable
     page, e.g. LIVE_WORLD_EMBED_URL: "https://<real-dashboard-host>/embed".
     (Placeholder shown only as a pattern; the real host is not known yet.)
     main.js then swaps the placeholder for a sandboxed, lazy-loaded iframe.
     If the dashboard uses a different technology (script widget, canvas app),
     replace mountLiveWorld() in main.js instead. See README.md. */
  LIVE_WORLD_EMBED_URL: "",
  LIVE_WORLD_EMBED_TITLE: "Osprey Core live world dashboard"
});
