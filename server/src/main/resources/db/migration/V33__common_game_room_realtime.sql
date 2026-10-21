-- R3: durable, room-scoped chat and replay. Kept separate from
-- game-specific Yacht/Drawing event streams and never stores credentials.
ALTER TABLE game_room ADD COLUMN event_sequence INTEGER NOT NULL DEFAULT 0
  CHECK(event_sequence >= 0);
CREATE TABLE game_room_chat (
  room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  message_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES game_room_member(member_id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(room_id, sequence),
  UNIQUE(room_id,message_id)
);
CREATE INDEX idx_game_room_chat_member
  ON game_room_chat(room_id,member_id,deleted_at);
CREATE TABLE game_room_event (
  room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(room_id,sequence)
);
