-- R13f: server-clock playback state; older revealed albums stay paused.
ALTER TABLE game_room_telephone_match
 ADD COLUMN reveal_playing INTEGER NOT NULL DEFAULT 0
 CHECK(reveal_playing IN (0,1));
ALTER TABLE game_room_telephone_match
 ADD COLUMN reveal_interval_seconds INTEGER NOT NULL DEFAULT 5
 CHECK(reveal_interval_seconds BETWEEN 3 AND 20);
ALTER TABLE game_room_telephone_match
 ADD COLUMN reveal_next_at TEXT;
