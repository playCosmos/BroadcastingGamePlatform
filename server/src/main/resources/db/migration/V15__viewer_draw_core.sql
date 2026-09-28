CREATE TABLE IF NOT EXISTS viewer_draw_session (
  session_id TEXT PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('RANDOM','NUMBER')),
  entry_source TEXT NOT NULL DEFAULT 'MANUAL_LIST',
  state TEXT NOT NULL CHECK(state IN ('DRAFT','FROZEN','COMPLETED','CANCELLED')),
  config_json TEXT NOT NULL,
  frozen_entry_hash TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS viewer_draw_entry (
  session_id TEXT NOT NULL,
  entry_index INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  provider_id TEXT,
  user_id TEXT,
  display_name TEXT NOT NULL,
  label TEXT NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY(session_id, entry_index),
  UNIQUE(session_id, entry_id),
  FOREIGN KEY(session_id) REFERENCES viewer_draw_session(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS viewer_draw_result (
  session_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  rng_algorithm TEXT NOT NULL,
  audit_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES viewer_draw_session(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_viewer_draw_session_updated
  ON viewer_draw_session(updated_at DESC);
