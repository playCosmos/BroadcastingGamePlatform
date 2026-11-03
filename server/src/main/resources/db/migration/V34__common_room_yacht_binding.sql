-- R4: durable one-to-one bridge from shared room identity to the
-- independently versioned Yacht Y2 match/event store.
CREATE TABLE game_room_yacht_link (
    room_id TEXT PRIMARY KEY NOT NULL
        REFERENCES game_room(room_id) ON DELETE CASCADE,
    yacht_room_code TEXT NOT NULL UNIQUE
        CHECK(length(yacht_room_code)=6),
    created_at TEXT NOT NULL
);
