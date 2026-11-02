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
    JAVA_ADDRESS: "osprey.build",
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

  /* Live World / Falcon live map (squaremap).
     -----------------------------------------------------------------------
     - "" : the bay shows its "coming soon" placeholder and nothing loads.
     - an https:// URL : main.js embeds it as a sandboxed, lazy-loaded iframe.
     - an http:// URL  : browsers block http pages inside the https site
       (mixed content), so the bay shows the map as online with a button
       that opens it in a new tab. Switch this to the https:// address once
       the map is served over HTTPS and the embed turns on automatically. */
  LIVE_WORLD_EMBED_URL: "https://map.osprey.build/",
  LIVE_WORLD_EMBED_TITLE: "Falcon live world map"
});
