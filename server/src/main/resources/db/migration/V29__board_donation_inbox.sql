CREATE TABLE IF NOT EXISTS board_donation_inbox (
  inbox_key TEXT PRIMARY KEY,
  donation_json TEXT NOT NULL,
  room_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING', 'DONE')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_board_donation_inbox_pending
  ON board_donation_inbox(state, created_at_ms, next_attempt_at_ms);
