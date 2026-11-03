-- R13c: allow independent cooperative drawing chains with the same
-- server-authoritative frozen participant order and private album lifecycle.
-- Old R13b rooms continue to use NORMAL without data conversion.
ALTER TABLE game_room_telephone_match
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'NORMAL'
  CHECK(mode IN ('NORMAL','COOP'));
