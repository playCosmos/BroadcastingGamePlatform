CREATE TABLE IF NOT EXISTS drawing_guess_room (
  room_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  drawer_policy TEXT NOT NULL CHECK(drawer_policy IN ('STREAMER_DRAWER','ROTATING_DRAWER')),
  streamer_participant_id TEXT,
  score_profile TEXT NOT NULL CHECK(score_profile IN ('FAST_GUESS','RANKED','NO_SCORE')),
  score_config_json TEXT NOT NULL,
  round_duration_seconds INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT','READY','ACTIVE','COMPLETED','CANCELLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drawing_guess_participant (
  room_id TEXT NOT NULL,
  participant_order INTEGER NOT NULL,
  participant_id TEXT NOT NULL,
  provider_id TEXT,
  user_id TEXT,
  display_name TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(room_id, participant_id),
  UNIQUE(room_id, participant_order),
  FOREIGN KEY(room_id) REFERENCES drawing_guess_room(room_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drawing_guess_match (
  match_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','COMPLETED','CANCELLED')),
  current_round_index INTEGER NOT NULL DEFAULT 0,
  total_rounds INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(room_id) REFERENCES drawing_guess_room(room_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drawing_guess_round (
  round_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  drawer_participant_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  accepted_answers_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','COMPLETED','CANCELLED')),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  drawer_score INTEGER NOT NULL DEFAULT 0,
  UNIQUE(match_id, round_index),
  FOREIGN KEY(match_id) REFERENCES drawing_guess_match(match_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drawing_guess_correct_guess (
  round_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score_awarded INTEGER NOT NULL,
  drawer_score_awarded INTEGER NOT NULL,
  guessed_at TEXT NOT NULL,
  PRIMARY KEY(round_id, participant_id),
  UNIQUE(round_id, rank),
  FOREIGN KEY(round_id) REFERENCES drawing_guess_round(round_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_drawing_guess_room_updated
  ON drawing_guess_room(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_drawing_guess_match_room
  ON drawing_guess_match(room_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_drawing_guess_round_match
  ON drawing_guess_round(match_id, round_index);
