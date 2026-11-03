-- Yacht Y2: match-level unique room code, exact-once commands and
-- monotonic replayable events. This is isolated from Board and Drawing Guess.
-- Upgrade existing Y1 installations rather than editing historical V29.
-- SQLite cannot ALTER a CHECK constraint. Rename/copy/drop before adding
-- Y2 foreign keys, preserving every Y1 match snapshot and version.
ALTER TABLE yacht_match RENAME TO yacht_match_v29;
CREATE TABLE yacht_match (
  match_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('READY','ACTIVE','PAUSED','FINISHED','CLOSED')),
  state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 65536),
  updated_at TEXT NOT NULL
);
INSERT INTO yacht_match(match_id,version,phase,state_json,updated_at)
  SELECT match_id,version,phase,state_json,updated_at FROM yacht_match_v29;
DROP TABLE yacht_match_v29;
CREATE INDEX IF NOT EXISTS idx_yacht_match_phase ON yacht_match(phase);

CREATE TABLE IF NOT EXISTS yacht_room (
  room_code TEXT PRIMARY KEY COLLATE BINARY
    CHECK(length(room_code)=6),
  match_id TEXT NOT NULL UNIQUE REFERENCES yacht_match(match_id) ON DELETE CASCADE,
  create_key TEXT NOT NULL UNIQUE,
  create_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS yacht_command (
  match_id TEXT NOT NULL REFERENCES yacht_match(match_id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  committed_version INTEGER NOT NULL,
  PRIMARY KEY(match_id, command_id)
);
CREATE TABLE IF NOT EXISTS yacht_event (
  match_id TEXT NOT NULL REFERENCES yacht_match(match_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(match_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_yacht_event_match_sequence ON yacht_event(match_id,sequence);
