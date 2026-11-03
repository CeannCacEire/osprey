// Tiny stand-in for Reddit used by local browser QA. Not deployed.
import http from "node:http";
let n = 0;
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const send = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json", "x-ratelimit-remaining": String(99 - (n++ % 50)), "x-ratelimit-used": String(n % 50), "x-ratelimit-reset": "420" }); res.end(JSON.stringify(o)); };
    console.log(req.method, u.pathname, body.slice(0, 200));
    if (u.pathname === "/token") return send({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "identity read submit" });
    if (u.pathname === "/authorize") { res.writeHead(302, { location: `http://localhost:8787/api/reddit/callback?state=${u.searchParams.get("state")}&code=ok` }); return res.end(); }
    if (u.pathname === "/api/v1/me") return send({ name: "osprey_build" });
    if (/^\/r\/\w+\/new$/.test(u.pathname)) return send({ data: { children: [
      { data: { name: "t3_q1a", subreddit: "mcservers", title: "Looking for a server that supports Java and Bedrock?", selftext: "Me and 3 friends want a survival server with a real economy. Any server recommendations?", author: "blockhead_22", permalink: "/r/mcservers/comments/q1a/looking_for_a_server/", created_utc: Date.now() / 1000 - 1800 } },
      { data: { name: "t3_q1b", subreddit: "mcservers", title: "[Weekly] Server recommendation thread", selftext: "", author: "AutoModerator", stickied: true, permalink: "/r/mcservers/comments/q1b/w/", created_utc: Date.now() / 1000 - 3600 } },
      { data: { name: "t3_q1c", subreddit: "mcservers", title: "Showing off my castle", selftext: "", author: "x", permalink: "/r/mcservers/comments/q1c/c/", created_utc: Date.now() / 1000 - 600 } },
    ] } });
    if (u.pathname === "/api/info") return send({ data: { children: [{ data: { name: u.searchParams.get("id"), subreddit: "admincraft", title: "What server should I join in 2026?", permalink: "/r/admincraft/comments/" + u.searchParams.get("id").slice(3) + "/what/", author: "someone" } }] } });
    if (u.pathname === "/api/comment") return send({ json: { errors: [], data: { things: [{ data: { name: "t1_c9", permalink: "/r/mcservers/comments/q1a/looking_for_a_server/c9/" } }] } } });
    if (u.pathname === "/api/submit") return send({ json: { errors: [], data: { name: "t3_p9", url: "https://www.reddit.com/r/mcservers/comments/p9/osprey/" } } });
    send({ error: "nope" }, 404);
  });
}).listen(9999, () => console.log("mock reddit on 9999"));
