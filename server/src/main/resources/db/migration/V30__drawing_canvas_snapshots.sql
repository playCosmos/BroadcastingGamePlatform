ALTER TABLE drawing_guess_canvas_session
  ADD COLUMN snapshot_sequence INTEGER NOT NULL DEFAULT 0;

ALTER TABLE drawing_guess_canvas_session
  ADD COLUMN snapshot_json TEXT;
