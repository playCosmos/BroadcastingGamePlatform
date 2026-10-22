-- R5: one common membership room can bind one independent Drawing Guess
-- rotating-player match. Legacy streamer DRAWING_GUESS rooms are unchanged.
CREATE TABLE game_room_drawing_link (
  room_id TEXT PRIMARY KEY NOT NULL
    REFERENCES game_room(room_id) ON DELETE CASCADE,
  drawing_room_code TEXT NOT NULL UNIQUE,
  match_id TEXT NOT NULL UNIQUE,
  total_rounds INTEGER NOT NULL CHECK(total_rounds BETWEEN 2 AND 120),
  created_at TEXT NOT NULL
);
