CREATE TABLE IF NOT EXISTS drawing_guess_canvas_session (
  round_id TEXT PRIMARY KEY,
  drawing_code TEXT NOT NULL UNIQUE,
  drawer_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','CLOSED')),
  closed_at TEXT,
  FOREIGN KEY(round_id) REFERENCES drawing_guess_round(round_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drawing_guess_canvas_event (
  round_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(round_id, sequence),
  FOREIGN KEY(round_id) REFERENCES drawing_guess_canvas_session(round_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_drawing_guess_canvas_code
  ON drawing_guess_canvas_session(drawing_code);

CREATE INDEX IF NOT EXISTS idx_drawing_guess_canvas_active
  ON drawing_guess_canvas_session(state, expires_at);
