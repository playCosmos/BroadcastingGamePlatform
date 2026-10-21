-- R2: room membership credentials and invitation grants. Never store bearer
-- tokens: hashes are SHA-256 over high-entropy server-generated secrets.
CREATE TABLE game_room_session (
  session_hash TEXT PRIMARY KEY NOT NULL CHECK(length(session_hash)=64),
  room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES game_room_member(member_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_game_room_session_member ON game_room_session(room_id,member_id);
CREATE TABLE game_room_invite (
  invite_hash TEXT PRIMARY KEY NOT NULL CHECK(length(invite_hash)=64),
  room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
  seat_role TEXT NOT NULL CHECK(seat_role IN ('PLAYER','SPECTATOR')),
  max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 256),
  used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0 AND used <= max_uses),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by_member_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_game_room_invite_room ON game_room_invite(room_id);
CREATE TABLE game_room_ban (
  room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(room_id,actor_id)
);
