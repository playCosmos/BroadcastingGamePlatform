CREATE TABLE IF NOT EXISTS viewer_draw_machine_map_revision (
  map_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(map_id, revision),
  FOREIGN KEY(map_id)
    REFERENCES viewer_draw_machine_map(map_id)
    ON DELETE CASCADE
);

INSERT OR IGNORE INTO viewer_draw_machine_map_revision(
  map_id,
  revision,
  schema_version,
  definition_json,
  definition_hash,
  created_at
)
SELECT
  map_id,
  revision,
  schema_version,
  definition_json,
  definition_hash,
  updated_at
FROM viewer_draw_machine_map;

CREATE INDEX IF NOT EXISTS idx_viewer_draw_machine_revision
  ON viewer_draw_machine_map_revision(map_id, revision DESC);
