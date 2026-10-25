-- R13d: a host-controlled shared slide cursor, visible only after reveal.
-- Readers retain their own local navigation and may opt in/out of following.
ALTER TABLE game_room_telephone_match
  ADD COLUMN presentation_enabled INTEGER NOT NULL DEFAULT 0
  CHECK(presentation_enabled IN (0,1));
ALTER TABLE game_room_telephone_match
  ADD COLUMN presentation_album INTEGER NOT NULL DEFAULT 0
  CHECK(presentation_album >= 0);
ALTER TABLE game_room_telephone_match
  ADD COLUMN presentation_step INTEGER NOT NULL DEFAULT 0
  CHECK(presentation_step >= 0);
ALTER TABLE game_room_telephone_match
  ADD COLUMN presentation_revision INTEGER NOT NULL DEFAULT 0
  CHECK(presentation_revision >= 0);
