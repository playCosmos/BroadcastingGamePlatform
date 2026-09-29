CREATE TABLE IF NOT EXISTS viewer_draw_machine_map (
  map_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  schema_version TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_viewer_draw_machine_map_updated
  ON viewer_draw_machine_map(updated_at DESC);
