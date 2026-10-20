package io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence;

import com.google.gson.Gson;
import com.google.gson.JsonParseException;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtMatchState;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring.Category;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.ConcurrentModificationException;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;

/**
 * Versioned Yacht match snapshot repository. No Board table reuse, no live
 * process state, no provider coupling. Each mutation is a single atomic SQL
 * compare-and-swap, also safe across multiple repository instances.
 *
 * Platform startup applies V29 before this repository is used.
 */
public final class YachtRepository {
    private static final Gson GSON = new Gson();
    private static final int SNAPSHOT_VERSION = 1;
    private static final int MAX_JSON_CHARS = 65536;
    private final DatabaseAccess database;

    private record ParticipantPayload(
        String id, String displayName, Map<String, Integer> scores,
        int repeatYachtCount
    ) {}
    private record MatchPayload(
        int schema, String id, String name, String phase,
        int currentPlayer, int completedTurns, int rolls,
        List<Integer> dice, List<Boolean> held, long version,
        List<ParticipantPayload> players
    ) {}

    public YachtRepository(DatabaseAccess database) {
        this.database = Objects.requireNonNull(database, "database");
    }

    /** Unique match ID is generated server-side and cannot be overwritten. */
    public YachtMatchState create(String name, List<YachtMatchState.Player> players)
        throws SQLException {
        YachtMatchState created = YachtMatchState.create(name, players);
        String snapshot = serialize(created);
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 INSERT INTO yacht_match(match_id,version,phase,state_json,updated_at)
                 VALUES(?,?,?,?,?)
                 """)) {
            statement.setString(1, created.id());
            statement.setLong(2, created.version());
            statement.setString(3, created.phase().name());
            statement.setString(4, snapshot);
            statement.setString(5, Instant.now().toString());
            statement.executeUpdate();
            return created;
        }
    }

    public YachtMatchState find(String id) throws SQLException {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("match ID required");
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT version,phase,state_json FROM yacht_match WHERE match_id=?
                 """)) {
            statement.setString(1, id);
            try (var rs = statement.executeQuery()) {
                if (!rs.next()) throw new NoSuchElementException("Yacht match not found");
                YachtMatchState restored = deserialize(rs.getString("state_json"));
                if (!restored.id().equals(id)
                    || restored.version() != rs.getLong("version")
                    || !restored.phase().name().equals(rs.getString("phase"))) {
                    throw new IllegalStateException("Yacht persisted snapshot/version mismatch");
                }
                return restored;
            }
        }
    }

    /**
     * expectedVersion prevents stale and racing actions from double-applying
     * a Roll, Hold, score commit or pause, even across separate JDBC sessions.
     */
    public YachtMatchState update(
        YachtMatchState next, long expectedVersion
    ) throws SQLException {
        Objects.requireNonNull(next, "next");
        if (expectedVersion < 0 || next.version() != expectedVersion + 1) {
            throw new IllegalArgumentException("Yacht command must increment version once");
        }
        String snapshot = serialize(next);
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE yacht_match
                 SET version=?,phase=?,state_json=?,updated_at=?
                 WHERE match_id=? AND version=?
                 """)) {
            statement.setLong(1, next.version());
            statement.setString(2, next.phase().name());
            statement.setString(3, snapshot);
            statement.setString(4, Instant.now().toString());
            statement.setString(5, next.id());
            statement.setLong(6, expectedVersion);
            if (statement.executeUpdate() != 1) {
                throw new ConcurrentModificationException(
                    "Yacht match stale version or no longer exists");
            }
            return next;
        }
    }

    /** A command always loads fresh authoritative state before transition. */
    public YachtMatchState apply(
        String id, java.util.function.UnaryOperator<YachtMatchState> command
    ) throws SQLException {
        Objects.requireNonNull(command, "command");
        YachtMatchState previous = find(id);
        YachtMatchState next = Objects.requireNonNull(command.apply(previous),
            "command state");
        if (!previous.id().equals(next.id())) {
            throw new IllegalArgumentException("Yacht command changed match identity");
        }
        return update(next, previous.version());
    }

    static String serialize(YachtMatchState match) {
        var participants = new ArrayList<ParticipantPayload>();
        for (var player : match.players()) {
            var categories = new LinkedHashMap<String, Integer>();
            for (var score : player.sheet().scores().entrySet()) {
                categories.put(score.getKey().id(), score.getValue());
            }
            participants.add(new ParticipantPayload(player.id(),
                player.displayName(), categories,
                player.sheet().repeatYachtCount()));
        }
        String json = GSON.toJson(new MatchPayload(SNAPSHOT_VERSION,
            match.id(), match.name(), match.phase().name(),
            match.currentPlayer(), match.completedTurns(), match.rolls(),
            match.dice(), match.held(), match.version(), participants));
        if (json.length() > MAX_JSON_CHARS) {
            throw new IllegalArgumentException("Yacht snapshot too large");
        }
        return json;
    }

    static YachtMatchState deserialize(String json) {
        if (json == null || json.length() > MAX_JSON_CHARS) {
            throw new IllegalStateException("Yacht snapshot missing or oversized");
        }
        try {
            MatchPayload payload = GSON.fromJson(json, MatchPayload.class);
            if (payload == null || payload.schema() != SNAPSHOT_VERSION
                || payload.players() == null) {
                throw new IllegalStateException("unknown Yacht persisted schema");
            }
            var players = new ArrayList<YachtMatchState.Player>();
            for (var entry : payload.players()) {
                if (entry == null || entry.scores() == null) {
                    throw new IllegalStateException("invalid Yacht participant snapshot");
                }
                var scores = new EnumMap<Category, Integer>(Category.class);
                for (var score : entry.scores().entrySet()) {
                    scores.put(Category.fromId(score.getKey()), score.getValue());
                }
                players.add(new YachtMatchState.Player(entry.id(),
                    entry.displayName(),
                    new YachtScoring.Sheet(scores, entry.repeatYachtCount())));
            }
            return new YachtMatchState(
                payload.id(), payload.name(), players,
                YachtMatchState.Phase.valueOf(payload.phase()),
                payload.currentPlayer(), payload.completedTurns(), payload.rolls(),
                payload.dice(), payload.held(), payload.version());
        } catch (JsonParseException | IllegalArgumentException | NullPointerException
                 | ClassCastException invalid) {
            throw new IllegalStateException("Yacht snapshot validation failed", invalid);
        }
    }
}
