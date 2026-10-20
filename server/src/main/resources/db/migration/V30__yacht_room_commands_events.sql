-- Yacht Y2: match-level unique room code, exact-once commands and
-- monotonic replayable events. This is isolated from Board and Drawing Guess.
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
