-- R1 common membership foundation. The game's match state and existing
-- Board/Drawing/Yacht room records are not moved or rewritten by this schema.
CREATE TABLE game_room (
    room_id TEXT PRIMARY KEY NOT NULL,
    game_id TEXT NOT NULL,
    room_code TEXT NOT NULL,
    owner_member_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('OPEN_LOBBY','PLAYING','POST_GAME','CLOSED')),
    max_players INTEGER NOT NULL CHECK(max_players >= 1),
    max_room_members INTEGER NOT NULL CHECK(max_room_members >= max_players),
    version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(game_id, room_code)
);
CREATE TABLE game_room_member (
    member_id TEXT PRIMARY KEY NOT NULL,
    room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    seat_role TEXT NOT NULL CHECK(seat_role IN ('PLAYER','SPECTATOR')),
    membership_status TEXT NOT NULL CHECK(membership_status IN
        ('JOINED','DISCONNECTED_GRACE','LEFT','KICKED')),
    ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
    grace_expires_at TEXT,
    joined_at TEXT NOT NULL,
    UNIQUE(room_id, actor_id),
    UNIQUE(room_id, member_id)
);
CREATE INDEX idx_game_room_member_capacity
    ON game_room_member(room_id, membership_status, seat_role);
CREATE INDEX idx_game_room_member_actor
    ON game_room_member(room_id, actor_id);
