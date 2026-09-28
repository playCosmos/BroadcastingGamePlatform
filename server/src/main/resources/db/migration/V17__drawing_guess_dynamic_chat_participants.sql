ALTER TABLE drawing_guess_participant
  ADD COLUMN can_draw INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_drawing_guess_provider_user
  ON drawing_guess_participant(room_id, provider_id, user_id)
  WHERE provider_id IS NOT NULL AND user_id IS NOT NULL;
