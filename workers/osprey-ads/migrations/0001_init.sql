-- Osprey Reddit outreach (osprey.build/ads) — D1 schema
-- Times are integer Unix milliseconds (UTC).

CREATE TABLE admin_users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,           -- base64 PBKDF2-SHA256
  password_salt   TEXT NOT NULL,           -- base64
  password_iter   INTEGER NOT NULL,
  disabled        INTEGER NOT NULL DEFAULT 0,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,
  last_login_at   INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash      TEXT PRIMARY KEY,        -- SHA-256 of the bearer token; the token itself is never stored
  admin_id        INTEGER NOT NULL REFERENCES admin_users(id),
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE INDEX idx_sessions_admin ON sessions(admin_id);

CREATE TABLE templates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('post','reply')),
  content_json    TEXT NOT NULL,           -- {title, body, cta, image_url, flair_text, post_type}
  notes           TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES admin_users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE subreddit_rules (
  subreddit             TEXT PRIMARY KEY COLLATE NOCASE,   -- without the r/ prefix
  ads_allowed           INTEGER NOT NULL DEFAULT 0,        -- may we make our own promotional posts?
  comments_allowed      INTEGER NOT NULL DEFAULT 0,        -- may we reply to threads?
  weekly_thread_only    INTEGER NOT NULL DEFAULT 0,        -- promotion only inside the sub's weekly/megathread
  weekly_thread_match   TEXT,                              -- case-insensitive text the megathread title must contain
  required_flair        INTEGER NOT NULL DEFAULT 0,
  flair_id              TEXT,                              -- link flair template id to send with posts
  flair_text            TEXT,
  cooldown_hours        INTEGER NOT NULL DEFAULT 168,
  max_per_day           INTEGER NOT NULL DEFAULT 1,
  blacklisted           INTEGER NOT NULL DEFAULT 0,
  paused                INTEGER NOT NULL DEFAULT 0,
  rules_url             TEXT,
  notes                 TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE watchers (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  subreddit             TEXT NOT NULL COLLATE NOCASE REFERENCES subreddit_rules(subreddit),
  keywords_json         TEXT NOT NULL,     -- ["looking for a server", ...]
  exclude_json          TEXT NOT NULL DEFAULT '[]',
  template_id           INTEGER REFERENCES templates(id),  -- optional: pre-fill a suggested reply draft
  max_age_hours         INTEGER NOT NULL DEFAULT 48,
  interval_minutes      INTEGER NOT NULL DEFAULT 60,
  enabled               INTEGER NOT NULL DEFAULT 1,
  last_scanned_at       INTEGER,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE candidate_opportunities (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_id            INTEGER REFERENCES watchers(id),
  subreddit             TEXT NOT NULL COLLATE NOCASE,
  reddit_fullname       TEXT NOT NULL UNIQUE,              -- t3_xxxxx
  title                 TEXT NOT NULL,
  excerpt               TEXT,
  author                TEXT,
  permalink             TEXT NOT NULL,
  matched_keywords      TEXT,                              -- JSON array
  score                 INTEGER NOT NULL DEFAULT 0,
  reddit_created_at     INTEGER,
  status                TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','drafted','dismissed','expired')),
  source                TEXT NOT NULL DEFAULT 'watcher' CHECK (source IN ('watcher','manual')),
  created_at            INTEGER NOT NULL
);
CREATE INDEX idx_candidates_status ON candidate_opportunities(status, created_at);

CREATE TABLE drafts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                  TEXT NOT NULL CHECK (kind IN ('post','reply')),
  subreddit             TEXT NOT NULL COLLATE NOCASE,
  thread_fullname       TEXT,                              -- reply target, t3_xxxxx
  thread_title          TEXT,
  thread_permalink      TEXT,
  content_json          TEXT NOT NULL,                     -- {title, body, cta, image_url, flair_id, flair_text, post_type}
  content_hash          TEXT NOT NULL,                     -- SHA-256 of the canonical submission payload
  text_fingerprint      TEXT NOT NULL,                     -- normalised text hash for duplicate detection
  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('suggested','draft','queued','submitting','submitted','failed','rejected','handoff')),
  template_id           INTEGER REFERENCES templates(id),
  candidate_id          INTEGER REFERENCES candidate_opportunities(id),
  version               INTEGER NOT NULL DEFAULT 1,
  reject_reason         TEXT,
  created_by            INTEGER REFERENCES admin_users(id),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_drafts_status ON drafts(status, updated_at);

CREATE TABLE approvals (
  id                    TEXT PRIMARY KEY,                  -- random id, travels in the queue message
  draft_id              INTEGER NOT NULL REFERENCES drafts(id),
  draft_version         INTEGER NOT NULL,
  content_hash          TEXT NOT NULL,                     -- exact payload hash the admin approved
  mode                  TEXT NOT NULL CHECK (mode IN ('api','handoff')),
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','processing','consumed','revoked','expired','rejected')),
  approved_by           INTEGER NOT NULL REFERENCES admin_users(id),
  approved_at           INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  consumed_at           INTEGER,
  status_reason         TEXT
);
CREATE INDEX idx_approvals_draft ON approvals(draft_id);

CREATE TABLE submissions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id              INTEGER NOT NULL REFERENCES drafts(id),
  approval_id           TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  kind                  TEXT NOT NULL,
  subreddit             TEXT NOT NULL COLLATE NOCASE,
  content_hash          TEXT NOT NULL,
  text_fingerprint      TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('submitted','failed','blocked')),
  reddit_fullname       TEXT,
  permalink             TEXT,
  error                 TEXT,
  ratelimit_remaining   REAL,
  ratelimit_reset       INTEGER,
  mode                  TEXT NOT NULL,
  created_at            INTEGER NOT NULL
);
CREATE INDEX idx_submissions_sub ON submissions(subreddit, status, created_at);
CREATE INDEX idx_submissions_fp ON submissions(text_fingerprint, status);

CREATE TABLE audit_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  at                    INTEGER NOT NULL,
  actor                 TEXT NOT NULL,                     -- 'admin:<name>', 'watcher', 'submitter', 'system'
  action                TEXT NOT NULL,
  entity_type           TEXT,
  entity_id             TEXT,
  detail_json           TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);

-- Supporting tables -------------------------------------------------------

CREATE TABLE reddit_accounts (
  id                    INTEGER PRIMARY KEY CHECK (id = 1), -- one connected account
  username              TEXT,
  scopes                TEXT,
  refresh_token_enc     TEXT NOT NULL,                     -- AES-GCM, key in TOKEN_ENC_KEY secret
  access_token_enc      TEXT,
  access_expires_at     INTEGER,
  connected_by          INTEGER REFERENCES admin_users(id),
  connected_at          INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state                 TEXT PRIMARY KEY,
  admin_id              INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL
);

CREATE TABLE rate_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  remaining             REAL,
  used                  REAL,
  reset_at              INTEGER,                            -- ms when the window resets
  updated_at            INTEGER
);
INSERT INTO rate_state (id, remaining, used, reset_at, updated_at) VALUES (1, NULL, NULL, NULL, NULL);

CREATE TABLE settings (
  key                   TEXT PRIMARY KEY,
  value                 TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('daily_cap', '3'),                -- max submissions per rolling 24 hours, all subreddits
  ('min_gap_minutes', '20'),         -- minimum time between any two submissions
  ('approval_ttl_minutes', '30'),    -- approvals expire if not submitted in time
  ('duplicate_window_days', '30'),   -- same text can't go to a second subreddit within this window
  ('submit_mode', 'api'),            -- 'api' (Reddit OAuth) or 'handoff' (you post it yourself on reddit.com)
  ('kill_switch', '0');              -- 1 = block every submission
