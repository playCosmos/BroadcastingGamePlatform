-- R13b: private, simultaneous prompt/draw/describe chains in shared GameRoom.
CREATE TABLE game_room_telephone_match (
  room_id TEXT PRIMARY KEY NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
  stage INTEGER NOT NULL DEFAULT 0,
  roster_size INTEGER NOT NULL CHECK(roster_size BETWEEN 3 AND 12),
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 30 AND 600),
  stage_started_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PLAYING','REVEAL'))
);
CREATE TABLE game_room_telephone_player (
  room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY(room_id,slot),
  UNIQUE(room_id,member_id)
);
CREATE TABLE game_room_telephone_entry (
  room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
  album_slot INTEGER NOT NULL,
  stage INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('TEXT','DRAWING')),
  content TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY(room_id,album_slot,stage)
);
CREATE INDEX idx_game_room_telephone_entries_stage
  ON game_room_telephone_entry(room_id,stage);
