-- R7: room activity is not a semantic room version/update. Only public
-- rooms carry heartbeat state; existing private rooms keep their R1 lifecycle.
ALTER TABLE game_room_public ADD COLUMN last_active_at TEXT;
UPDATE game_room_public SET last_active_at=created_at;
CREATE INDEX idx_game_room_public_idle
  ON game_room_public(last_active_at);
