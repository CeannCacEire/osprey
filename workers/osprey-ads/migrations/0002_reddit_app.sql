-- Reddit app credentials entered from the /ads dashboard (instead of Worker secrets).
-- The client secret is AES-GCM encrypted with TOKEN_ENC_KEY, like the refresh token.
-- Worker secrets REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET, if set, take precedence.
CREATE TABLE reddit_app (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  client_id          TEXT NOT NULL,
  client_secret_enc  TEXT NOT NULL,
  username           TEXT,              -- used in the User-Agent: (by /u/<username>)
  updated_by         INTEGER,
  updated_at         INTEGER NOT NULL
);
