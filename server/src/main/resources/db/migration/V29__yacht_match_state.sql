-- Y1 domain storage only. No public Yacht room/API is created by this migration.
-- Snapshot writes use WHERE version = ? compare-and-swap. This table stays
-- independent of Board and Drawing Guess game tables.
CREATE TABLE IF NOT EXISTS yacht_match (
    match_id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    phase TEXT NOT NULL CHECK (phase IN ('READY','ACTIVE','PAUSED','FINISHED')),
    state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 65536),
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yacht_match_phase ON yacht_match(phase);
