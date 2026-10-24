-- R13a: host-assigned, operator-approved SOOP channel -> actual player member.
-- The association is editable ONLY before the game starts. At reservation
-- the authoritative order is frozen in a separate immutable membership roster.
ALTER TABLE game_room_drawing_broadcast_binding
    ADD COLUMN drawer_member_id TEXT;
ALTER TABLE game_room_drawing_link
    ADD COLUMN streamer_rotation INTEGER NOT NULL DEFAULT 0
    CHECK(streamer_rotation IN (0,1));

CREATE TABLE game_room_drawing_drawer_roster (
    room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
    drawer_order INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    PRIMARY KEY(room_id,member_id),
    UNIQUE(room_id,drawer_order)
);
CREATE INDEX idx_game_room_drawer_roster_order
    ON game_room_drawing_drawer_roster(room_id,drawer_order);
