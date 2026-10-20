package io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence;

import com.google.gson.Gson;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtMatchState;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring.Category;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.ConcurrentModificationException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;

/**
 * Y2 room lifecycle and exactly-once command boundary.
 * All state, idempotency and replay events commit in ONE SQLite transaction.
 * WebSocket notification is best-effort after commit; clients can recover
 * any missed event via sequence-based REST replay.
 */
public final class YachtRoomService {
    private static final Gson GSON = new Gson();
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();
    private static final Object MUTATION_LOCK = new Object();
    private static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final int MAX_EVENTS_PAGE = 100;
    private final DatabaseAccess database;
    private final YachtMatchState.DiceRandomSource random;
    private final Broadcast broadcast;

    @FunctionalInterface
    public interface Broadcast {
        void onEvent(String roomCode, String json);
    }

    public record Participant(String id, String displayName) {}
    public record RoomState(String roomCode, YachtMatchState match,
                            YachtScoring.Choices availableScores) {}
    public record Event(String type, String gameId, String roomCode,
                        long sequence, String timestamp, YachtMatchState match) {}
    public record Command(String commandId, long expectedVersion,
                          List<Boolean> held, String category) {}

    public YachtRoomService(DatabaseAccess database, Broadcast broadcast) {
        this(database, new YachtMatchState.SecureDiceRandomSource(), broadcast);
    }

    public YachtRoomService(DatabaseAccess database,
                            YachtMatchState.DiceRandomSource random,
                            Broadcast broadcast) {
        this.database = Objects.requireNonNull(database, "database");
        this.random = Objects.requireNonNull(random, "random");
        this.broadcast = broadcast == null ? (code, json) -> {} : broadcast;
    }

    public RoomState create(String requestId, String name,
                            List<Participant> participants) throws SQLException {
        String key = requireId(requestId);
        if (participants == null) throw new IllegalArgumentException("players required");
        var players = new ArrayList<YachtMatchState.Player>();
        for (Participant p : participants) {
            if (p == null) throw new IllegalArgumentException("null participant");
            players.add(new YachtMatchState.Player(p.id(), p.displayName(),
                YachtScoring.Sheet.empty()));
        }
        // Construct before touching the database, to validate player count,
        // names and identity uniqueness.
        YachtMatchState match = YachtMatchState.create(name, players);
        String fingerprint = digest(GSON.toJson(
            List.of(match.name(), participants)));
        synchronized (MUTATION_LOCK) {
            try (var connection = database.open()) {
                connection.setAutoCommit(false);
                try {
                    RoomState existing = findCreated(connection, key, fingerprint);
                    if (existing != null) {
                        connection.rollback();
                        return existing;
                    }
                    String code = allocateCode(connection);
                    try (var insert = connection.prepareStatement("""
                        INSERT INTO yacht_match(match_id,version,phase,state_json,updated_at)
                        VALUES(?,?,?,?,?)
                        """)) {
                        insert.setString(1, match.id());
                        insert.setLong(2, match.version());
                        insert.setString(3, match.phase().name());
                        insert.setString(4, YachtRepository.serialize(match));
                        insert.setString(5, Instant.now().toString());
                        insert.executeUpdate();
                    }
                    try (var insert = connection.prepareStatement("""
                        INSERT INTO yacht_room(room_code,match_id,create_key,create_hash,created_at)
                        VALUES(?,?,?,?,?)
                        """)) {
                        insert.setString(1, code);
                        insert.setString(2, match.id());
                        insert.setString(3, key);
                        insert.setString(4, fingerprint);
                        insert.setString(5, Instant.now().toString());
                        insert.executeUpdate();
                    }
                    Event event = event("yacht.room.created", code, match);
                    insertEvent(connection, event);
                    connection.commit();
                    notifyAfterCommit(event);
                    return view(code, match);
                } catch (Exception failed) {
                    connection.rollback();
                    if (failed instanceof SQLException sql) throw sql;
                    if (failed instanceof RuntimeException runtime) throw runtime;
                    throw new SQLException("failed to create Yacht room", failed);
                } finally { connection.setAutoCommit(true); }
            }
        }
    }

    /** Public room-code capability: no administrator secrets are included. */
    public RoomState state(String code) throws SQLException {
        String normalized = validCode(code);
        try (var connection = database.open()) {
            return roomState(connection, normalized);
        }
    }

    public boolean exists(String code) {
        try { return state(code) != null; }
        catch (SQLException | RuntimeException error) { return false; }
    }

    public List<Event> events(String code, long since) throws SQLException {
        if (since < -1) throw new IllegalArgumentException("invalid event sequence");
        String normalized = validCode(code);
        try (var connection = database.open()) {
            String matchId = matchId(connection, normalized);
            var events = new ArrayList<Event>();
            try (var statement = connection.prepareStatement("""
                SELECT event_json FROM yacht_event
                WHERE match_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?
                """)) {
                statement.setString(1, matchId);
                statement.setLong(2, since);
                statement.setInt(3, MAX_EVENTS_PAGE);
                try (var rows = statement.executeQuery()) {
                    while (rows.next()) {
                        var event = GSON.fromJson(rows.getString(1), Event.class);
                        if (event == null || !normalized.equals(event.roomCode())) {
                            throw new IllegalStateException("invalid Yacht event log");
                        }
                        events.add(event);
                    }
                }
            }
            return List.copyOf(events);
        }
    }

    public RoomState command(String code, String action, Command command)
        throws SQLException {
        String normalized = validCode(code);
        Objects.requireNonNull(command, "command");
        String commandId = requireId(command.commandId());
        if (command.expectedVersion() < 0) {
            throw new IllegalArgumentException("expectedVersion required");
        }
        if (!List.of("activate","roll","hold","score","pause","resume","close")
            .contains(action)) {
            throw new IllegalArgumentException("unknown Yacht action");
        }
        if (command.held() != null && !"hold".equals(action)
            || command.category() != null && !"score".equals(action)) {
            throw new IllegalArgumentException("unexpected Yacht action arguments");
        }
        // The request signature includes expectedVersion and all action inputs.
        // Same commandId with altered payload is a conflict, never a replay.
        String hash = digest(GSON.toJson(List.of(action,
            command.expectedVersion(),
            command.held() == null ? "-" : command.held(),
            command.category() == null ? "-" : command.category())));
        synchronized (MUTATION_LOCK) {
            try (var connection = database.open()) {
                connection.setAutoCommit(false);
                try {
                    String matchId = matchId(connection, normalized);
                    RoomState replayed = findCommand(connection, normalized,
                        matchId, commandId, hash);
                    if (replayed != null) {
                        connection.rollback();
                        return replayed;
                    }
                    RoomState prior = roomState(connection, normalized);
                    YachtMatchState previous = prior.match();
                    if (previous.version() != command.expectedVersion()) {
                        throw new ConcurrentModificationException("Yacht stale command version");
                    }
                    YachtMatchState next = switch (action) {
                        case "activate" -> previous.start();
                        case "roll" -> previous.roll(random);
                        case "hold" -> previous.setHeld(command.held());
                        case "score" -> previous.commitScore(
                            Category.fromId(command.category()));
                        case "pause" -> previous.pause();
                        case "resume" -> previous.resume();
                        case "close" -> previous.close();
                        default -> throw new IllegalStateException("unknown action");
                    };
                    String serialized = YachtRepository.serialize(next);
                    try (var update = connection.prepareStatement("""
                        UPDATE yacht_match
                        SET version=?,phase=?,state_json=?,updated_at=?
                        WHERE match_id=? AND version=?
                        """)) {
                        update.setLong(1, next.version());
                        update.setString(2, next.phase().name());
                        update.setString(3, serialized);
                        update.setString(4, Instant.now().toString());
                        update.setString(5, matchId);
                        update.setLong(6, previous.version());
                        if (update.executeUpdate() != 1) {
                            throw new ConcurrentModificationException("Yacht command conflict");
                        }
                    }
                    Event event = event("yacht." + action + ".committed", normalized, next);
                    insertEvent(connection, event);
                    try (var insert = connection.prepareStatement("""
                        INSERT INTO yacht_command(
                          match_id,command_id,request_hash,response_json,committed_version
                        ) VALUES(?,?,?,?,?)
                        """)) {
                        insert.setString(1, matchId);
                        insert.setString(2, commandId);
                        insert.setString(3, hash);
                        insert.setString(4, serialized);
                        insert.setLong(5, next.version());
                        insert.executeUpdate();
                    }
                    connection.commit();
                    notifyAfterCommit(event);
                    return view(normalized, next);
                } catch (Exception failed) {
                    connection.rollback();
                    if (failed instanceof SQLException sql) throw sql;
                    if (failed instanceof RuntimeException runtime) throw runtime;
                    throw new SQLException("Yacht command failed", failed);
                } finally { connection.setAutoCommit(true); }
            }
        }
    }

    private static RoomState findCreated(
        Connection connection, String key, String hash
    ) throws SQLException {
        try (var query = connection.prepareStatement("""
            SELECT room_code,create_hash FROM yacht_room WHERE create_key=?
            """)) {
            query.setString(1, key);
            try (var rows = query.executeQuery()) {
                if (!rows.next()) return null;
                if (!hash.equals(rows.getString(2))) {
                    throw new ConcurrentModificationException(
                        "Yacht create requestId reused with different players");
                }
                return roomState(connection, rows.getString(1));
            }
        }
    }

    private static RoomState findCommand(
        Connection connection, String code, String matchId, String commandId, String hash
    ) throws SQLException {
        try (var query = connection.prepareStatement("""
            SELECT request_hash,response_json FROM yacht_command
            WHERE match_id=? AND command_id=?
            """)) {
            query.setString(1, matchId);
            query.setString(2, commandId);
            try (var rows = query.executeQuery()) {
                if (!rows.next()) return null;
                if (!hash.equals(rows.getString(1))) {
                    throw new ConcurrentModificationException(
                        "Yacht commandId reused with different payload");
                }
                return view(code, YachtRepository.deserialize(rows.getString(2)));
            }
        }
    }

    private static RoomState roomState(Connection connection, String code)
        throws SQLException {
        String matchId = matchId(connection, code);
        try (var query = connection.prepareStatement("""
            SELECT state_json,version,phase FROM yacht_match WHERE match_id=?
            """)) {
            query.setString(1, matchId);
            try (var rows = query.executeQuery()) {
                if (!rows.next()) throw new NoSuchElementException("Yacht match missing");
                YachtMatchState match = YachtRepository.deserialize(rows.getString(1));
                if (!match.id().equals(matchId)
                    || match.version() != rows.getLong(2)
                    || !match.phase().name().equals(rows.getString(3))) {
                    throw new IllegalStateException("Yacht match persistence mismatch");
                }
                return view(code, match);
            }
        }
    }

    private static String matchId(Connection connection, String code) throws SQLException {
        try (var query = connection.prepareStatement(
            "SELECT match_id FROM yacht_room WHERE room_code=?")) {
            query.setString(1, code);
            try (var rows = query.executeQuery()) {
                if (!rows.next()) throw new NoSuchElementException("Yacht room not found");
                return rows.getString(1);
            }
        }
    }

    private static RoomState view(String code, YachtMatchState match) {
        YachtScoring.Choices choices = match.phase() == YachtMatchState.Phase.ACTIVE
            && match.rolls() > 0 ? match.availableScores() : null;
        return new RoomState(code, match, choices);
    }

    private static Event event(String type, String code, YachtMatchState state) {
        return new Event(type, "yacht", code, state.version(),
            Instant.now().toString(), state);
    }

    private static void insertEvent(Connection connection, Event event)
        throws SQLException {
        try (var statement = connection.prepareStatement("""
            INSERT INTO yacht_event(match_id,sequence,event_type,event_json,created_at)
            VALUES(?,?,?,?,?)
            """)) {
            statement.setString(1, event.match().id());
            statement.setLong(2, event.sequence());
            statement.setString(3, event.type());
            statement.setString(4, GSON.toJson(event));
            statement.setString(5, event.timestamp());
            statement.executeUpdate();
        }
    }

    private void notifyAfterCommit(Event event) {
        try { broadcast.onEvent(event.roomCode(), GSON.toJson(event)); }
        catch (RuntimeException failure) {
            System.err.println("[yacht] websocket broadcast failed; event can be replayed");
        }
    }

    private static String allocateCode(Connection connection) throws SQLException {
        for (int attempt = 0; attempt < 100; attempt++) {
            var code = new StringBuilder(6);
            for (int index = 0; index < 6; index++) {
                code.append(ALPHABET.charAt(SECURE_RANDOM.nextInt(ALPHABET.length())));
            }
            try (var stmt = connection.prepareStatement(
                "SELECT 1 FROM yacht_room WHERE room_code=?")) {
                stmt.setString(1, code.toString());
                try (var rows = stmt.executeQuery()) {
                    if (!rows.next()) return code.toString();
                }
            }
        }
        throw new IllegalStateException("Yacht room code allocation failed");
    }

    private static String validCode(String code) {
        if (code == null || !code.matches("[A-HJ-NP-Z2-9]{6}")) {
            throw new NoSuchElementException("Yacht room not found");
        }
        return code;
    }

    private static String requireId(String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{8,100}")) {
            throw new IllegalArgumentException("Yacht request ID must be 8-100 characters");
        }
        return id;
    }

    private static String digest(String raw) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256")
                .digest(raw.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
