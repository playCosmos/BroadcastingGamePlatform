-- R13d: presenter position is authoritative and persisted for reconnects.
-- Every existing completed R13b/R13c album begins at its first frame.
ALTER TABLE game_room_telephone_match
  ADD COLUMN reveal_album INTEGER NOT NULL DEFAULT 0
  CHECK(reveal_album BETWEEN 0 AND 11);
ALTER TABLE game_room_telephone_match
  ADD COLUMN reveal_step INTEGER NOT NULL DEFAULT 0
  CHECK(reveal_step BETWEEN 0 AND 11);
ALTER TABLE game_room_telephone_match
  ADD COLUMN reveal_revision INTEGER NOT NULL DEFAULT 0
  CHECK(reveal_revision >= 0);
