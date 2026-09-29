CREATE TABLE viewer_draw_marble_audit (
  audit_id TEXT PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  result_status TEXT NOT NULL,
  qualification_status TEXT NOT NULL,
  map_name TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  entry_snapshot_hash TEXT NOT NULL,
  engine_id TEXT NOT NULL,
  seed INTEGER NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  audit_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_viewer_draw_marble_audit_created
  ON viewer_draw_marble_audit(created_at DESC);

CREATE INDEX idx_viewer_draw_marble_audit_definition
  ON viewer_draw_marble_audit(definition_hash, created_at DESC);
