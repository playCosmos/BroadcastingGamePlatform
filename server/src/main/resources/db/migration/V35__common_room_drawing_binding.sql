-- R5: common-game-room binding for existing Drawing Guess domain.
-- Legacy streamer rooms remain source_room_id NULL.
ALTER TABLE drawing_guess_room ADD COLUMN source_room_id TEXT;
CREATE UNIQUE INDEX ux_drawing_guess_source_room
  ON drawing_guess_room(source_room_id) WHERE source_room_id IS NOT NULL;
CREATE TABLE game_room_drawing_link (
  room_id TEXT PRIMARY KEY NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
  drawing_room_id TEXT NOT NULL UNIQUE REFERENCES drawing_guess_room(room_id),
  match_id TEXT UNIQUE REFERENCES drawing_guess_match(match_id),
  drawer_policy TEXT NOT NULL CHECK(drawer_policy IN ('STREAMER_DRAWER','ROTATING_DRAWER')),
  created_at TEXT NOT NULL
);
