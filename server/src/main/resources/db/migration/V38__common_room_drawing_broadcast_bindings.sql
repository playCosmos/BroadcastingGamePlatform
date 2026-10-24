-- R12a: explicit provider/channel routing for native Drawing Guess rooms hosted
-- in common GameRoom. Bindings do not create external provider connections.
-- A received provider/channel pair may belong to at most one shared room.
CREATE TABLE game_room_drawing_broadcast_binding (
    room_id TEXT NOT NULL REFERENCES game_room(room_id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 32),
    channel_id TEXT NOT NULL CHECK(length(channel_id) BETWEEN 1 AND 128),
    added_at TEXT NOT NULL,
    PRIMARY KEY (room_id, provider, channel_id),
    UNIQUE (provider, channel_id)
);
CREATE INDEX idx_game_room_drawing_broadcast_room
    ON game_room_drawing_broadcast_binding(room_id);

-- A closed common room must not hold a platform channel indefinitely.
-- Covers explicit host close and lifecycle-driven idle expiration.
CREATE TRIGGER trg_release_drawing_broadcast_on_room_close
AFTER UPDATE OF state ON game_room
WHEN NEW.state='CLOSED' AND OLD.state<>'CLOSED'
BEGIN
    DELETE FROM game_room_drawing_broadcast_binding
    WHERE room_id=NEW.room_id;
END;
