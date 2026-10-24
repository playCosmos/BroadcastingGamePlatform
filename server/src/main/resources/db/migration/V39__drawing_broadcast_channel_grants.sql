-- R12c: existing V38 room/channel labels are NOT trusted grants.
-- Only bindings with authorized_at populated can route external guesses.
ALTER TABLE game_room_drawing_broadcast_binding
  ADD COLUMN authorized_at TEXT;

-- Short-lived, one-use administrator-issued room/channel grants.
-- Raw bearer secrets must never be persisted.
CREATE TABLE game_room_drawing_broadcast_grant (
  grant_hash TEXT PRIMARY KEY NOT NULL CHECK(length(grant_hash)=64),
  room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_game_room_drawing_grant_room
  ON game_room_drawing_broadcast_grant(room_id);
