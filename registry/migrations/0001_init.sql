-- One row per build (owner/name); mirrors the metadata of its latest version.
CREATE TABLE builds (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  requires TEXT NOT NULL DEFAULT '{}',
  provides TEXT NOT NULL DEFAULT '[]',
  license TEXT NOT NULL,
  repository TEXT,
  latest TEXT NOT NULL,
  risk TEXT NOT NULL,
  quality INTEGER NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX builds_owner ON builds (owner);

-- Versions are immutable once published.
CREATE TABLE versions (
  build_id TEXT NOT NULL REFERENCES builds (id),
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  readme TEXT,
  integration TEXT,
  files TEXT NOT NULL,
  integrity TEXT NOT NULL,
  size INTEGER NOT NULL,
  risk TEXT NOT NULL,
  quality INTEGER NOT NULL,
  findings TEXT NOT NULL,
  publisher TEXT NOT NULL,
  published_at TEXT NOT NULL,
  yanked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (build_id, version)
);

-- Anonymous community signals: did the build work for you, or is it harmful?
-- One vote per kind, build, client and day; IPs are stored only as salted hashes.
CREATE TABLE feedback (
  build_id TEXT NOT NULL,
  version TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('success', 'failure', 'report')),
  note TEXT,
  client TEXT,
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (build_id, kind, ip_hash, day)
);

CREATE VIRTUAL TABLE builds_fts USING fts5 (
  id UNINDEXED,
  name,
  description,
  keywords,
  readme,
  tokenize = 'porter unicode61'
);
