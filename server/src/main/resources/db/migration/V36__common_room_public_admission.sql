-- Public/admission-enabled rooms are explicitly opt-in. Existing R1-R5
-- administrator-created and invitation-only rooms remain private by default.
-- One row per public room keeps visibility independent of membership.
CREATE TABLE game_room_public (
  room_id TEXT PRIMARY KEY NOT NULL
    REFERENCES game_room(room_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_game_room_public_recent ON game_room_public(created_at DESC);
