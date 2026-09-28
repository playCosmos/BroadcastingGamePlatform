ALTER TABLE board_room_player
  ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'SOOP';

CREATE INDEX IF NOT EXISTS idx_board_room_player_provider_user
  ON board_room_player(provider_id, soop_id, balloon_trigger);

ALTER TABLE board_game_player_state
  ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'SOOP';

ALTER TABLE board_game_deferred_donation
  ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'SOOP';

ALTER TABLE board_game_event
  ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'SOOP';
