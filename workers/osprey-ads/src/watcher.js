/* osprey-ads-watcher — cron-triggered. Finds candidates; never posts. */
import { runDueWatchers } from "./lib/watch.js";
import { audit } from "./lib/util.js";
import { withRedditApp } from "./lib/reddit.js";

export default {
  async scheduled(controller, env, ctx) {
    env = await withRedditApp(env);
    const r = await runDueWatchers(env, env.DB, Number(env.WATCHERS_PER_RUN || 5));
    if (r.reason) await audit(env.DB, "watcher", "watcher.idle", null, null, r);
  },
  async fetch() { return new Response("osprey-ads-watcher: cron only", { status: 404 }); },
};
