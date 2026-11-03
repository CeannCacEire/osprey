# osprey-ads: back end for osprey.build/ads

Internal Reddit outreach console. It finds opportunities, helps you write posts and
replies, and sends them **only after an admin approves each one by hand**. There is
no autonomous posting, no auto-replies, no unattended scheduling and no mass
cross-posting.

## Architecture

```
osprey.build/ads (static pages, GitHub Pages)
        │  bearer session, CORS limited to https://osprey.build
        ▼
osprey-ads-api  (Worker, HTTP)  ── D1 "osprey-ads" ──┐
        │ approve → enqueue (paced by min-gap delay)   │
        ▼                                              │
Queue "osprey-ads-submissions" (batch 1, concurrency 1, DLQ)
        ▼                                              │
osprey-ads-submitter (queue consumer) ─────────────────┤  re-checks approval, hash, rules, caps
        │ oauth.reddit.com /api/submit, /api/comment   │
osprey-ads-watcher (cron */15) ────────────────────────┘  reads /r/<sub>/new, creates candidates only
```

- **Approval record**: every approval stores the SHA-256 `content_hash` of the exact
  normalised draft (`ads/assets/content.js`, shared by browser and Workers), the draft
  version and an expiry. Editing a draft revokes its approval. The submitter refuses
  anything whose hash, version, status or expiry no longer match, and atomically claims
  the approval so it can only be used once.
- **Hard blocks** (`src/lib/policy.js`): no rules recorded, blacklisted, paused, posts or
  replies not allowed, weekly-thread-only, missing required flair, cooldown, per-sub and
  global daily caps, duplicate text in the same sub, same text in another sub inside the
  cross-post window, kill switch. Checked at approval and again just before sending.
- **Rate limits**: `X-Ratelimit-Remaining`, `-Used` and `-Reset` from every Reddit
  response are stored in D1 and checked before each call. 429 or `RATELIMIT` errors
  requeue with a delay; any other error fails the item without retrying, so nothing is
  posted twice.
- **OAuth**: Reddit "web app", `duration=permanent`, scopes `identity read submit`.
  The refresh token is AES-GCM encrypted with `TOKEN_ENC_KEY`. Authenticated calls go to
  `https://oauth.reddit.com`.
- **Hand-off mode**: if you don't have Reddit API access, set Submission mode to
  "Manual hand-off" on the dashboard. Approval and hash checks still apply; you post the
  approved text yourself on reddit.com and paste the permalink back. The watcher still
  needs API access.

## Setup

1. **Cloudflare**: create an API token with Workers Scripts:Edit, D1:Edit and
   Queues:Edit. Add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
2. **Reddit app** (only if your account has approved Data API access): create a
   "web app" at <https://www.reddit.com/prefs/apps> with redirect URI
   `https://osprey-ads-api.genocchi.workers.dev/api/reddit/callback`.
   Add secrets `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`, and a repository
   **variable** `REDDIT_USERNAME` (used in the User-Agent).
3. **Encryption key**: `openssl rand -base64 32` → secret `TOKEN_ENC_KEY`.
4. **First admin**: pick a long random value → secret `ADMIN_SETUP_TOKEN`.
5. Run the "Deploy /ads workers" workflow (Actions tab). It finds or creates the D1
   database and queues, applies migrations, deploys the three Workers and pushes the
   secrets above.
6. Open <https://osprey.build/ads/>, choose "Create the first admin", enter the setup
   token, then sign in. Setup is refused once an admin exists.
7. On Subreddits, record each community's rules, then add watchers. Subreddits
   without rules are always blocked.

## Local development

```
npm ci
npm test                      # end-to-end tests against local D1 with a mocked Reddit
cp scripts/dev.vars.example .dev.vars   # fill in, then:
node scripts/mock-reddit.mjs &
npx wrangler d1 migrations apply osprey-ads --local -c wrangler.api.toml
npx wrangler dev -c wrangler.api.toml -c wrangler.submitter.toml --port 8787
```

For local browser testing, point `ads/assets/config.js` and the pages' CSP
`connect-src` at `http://localhost:8787` in a scratch copy of the site. Do not commit
that change.
