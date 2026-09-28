CREATE TABLE board_room_player_v14 (
  room_id TEXT NOT NULL,
  player_index INTEGER NOT NULL CHECK (player_index >= 0 AND player_index < 6),
  provider_id TEXT NOT NULL DEFAULT 'SOOP',
  soop_id TEXT NOT NULL,
  display_name TEXT,
  profile_image_url TEXT,
  balloon_trigger INTEGER NOT NULL CHECK (balloon_trigger > 0),
  live_status TEXT NOT NULL DEFAULT 'NOT_CHECKED',
  live_bno TEXT,
  live_title TEXT,
  live_checked_at TEXT,
  live_check_error TEXT,
  PRIMARY KEY (room_id, player_index),
  UNIQUE (room_id, provider_id, soop_id),
  FOREIGN KEY (room_id) REFERENCES board_room(room_id) ON DELETE CASCADE
);

INSERT INTO board_room_player_v14(
  room_id, player_index, provider_id, soop_id,
  display_name, profile_image_url, balloon_trigger,
  live_status, live_bno, live_title, live_checked_at, live_check_error
)
SELECT
  room_id, player_index,
  CASE
    WHEN provider_id IS NULL OR trim(provider_id) = '' THEN 'SOOP'
    ELSE upper(provider_id)
  END,
  soop_id, display_name, profile_image_url, balloon_trigger,
  live_status, live_bno, live_title, live_checked_at, live_check_error
FROM board_room_player;

DROP TABLE board_room_player;
ALTER TABLE board_room_player_v14 RENAME TO board_room_player;

CREATE INDEX idx_board_room_status_updated_v14
  ON board_room(status, updated_at);

CREATE INDEX idx_board_room_player_soop
  ON board_room_player(soop_id, balloon_trigger);

CREATE INDEX idx_board_room_player_provider_user
  ON board_room_player(provider_id, soop_id, balloon_trigger);

CREATE TABLE board_game_player_state_v14 (
  room_id TEXT NOT NULL,
  player_index INTEGER NOT NULL,
  provider_id TEXT NOT NULL DEFAULT 'SOOP',
  soop_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  laps INTEGER NOT NULL DEFAULT 0,
  skip_next_throws INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  next_throw_multiplier INTEGER NOT NULL DEFAULT 1,
  ignore_next_landing_effects INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, player_index),
  UNIQUE (room_id, provider_id, soop_id),
  FOREIGN KEY (room_id) REFERENCES board_room(room_id) ON DELETE CASCADE
);

INSERT INTO board_game_player_state_v14(
  room_id, player_index, provider_id, soop_id,
  position, laps, skip_next_throws, updated_at,
  next_throw_multiplier, ignore_next_landing_effects
)
SELECT
  room_id, player_index,
  CASE
    WHEN provider_id IS NULL OR trim(provider_id) = '' THEN 'SOOP'
    ELSE upper(provider_id)
  END,
  soop_id, position, laps, skip_next_throws, updated_at,
  next_throw_multiplier, ignore_next_landing_effects
FROM board_game_player_state;

DROP TABLE board_game_player_state;
ALTER TABLE board_game_player_state_v14 RENAME TO board_game_player_state;

CREATE INDEX idx_board_game_player_match
  ON board_game_player_state(room_id, soop_id);

CREATE INDEX idx_board_game_player_provider_match
  ON board_game_player_state(room_id, provider_id, soop_id);
