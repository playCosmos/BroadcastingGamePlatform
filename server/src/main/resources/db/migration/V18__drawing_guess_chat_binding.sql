ALTER TABLE drawing_guess_room
  ADD COLUMN chat_guess_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE drawing_guess_room
  ADD COLUMN chat_provider TEXT;

ALTER TABLE drawing_guess_room
  ADD COLUMN chat_channel_id TEXT;

CREATE INDEX IF NOT EXISTS idx_drawing_guess_chat_binding
  ON drawing_guess_room(
    state,
    chat_guess_enabled,
    chat_provider,
    chat_channel_id
  );
