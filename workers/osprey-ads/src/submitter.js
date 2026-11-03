/* osprey-ads-submitter — queue consumer. One message at a time (max_batch_size 1,
   max_concurrency 1), each carrying only an approval id. */
import { processApproval } from "./lib/submit.js";
import { audit } from "./lib/util.js";

export default {
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const id = msg.body?.approval_id;
      if (!id) { msg.ack(); continue; }
      try {
        const r = await processApproval(env, env.DB, id);
        if (r.done) msg.ack(); else msg.retry({ delaySeconds: r.delaySeconds });
      } catch (e) {
        console.error("submitter", id, e);
        await audit(env.DB, "submitter", "submission.error", "approval", id, { error: String(e.message || e) });
        msg.retry({ delaySeconds: 60 });
      }
    }
  },
  async fetch() { return new Response("osprey-ads-submitter: queue consumer only", { status: 404 }); },
};
