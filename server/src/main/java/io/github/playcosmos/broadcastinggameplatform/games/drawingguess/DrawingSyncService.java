package io.github.playcosmos.broadcastinggameplatform.games.drawingguess;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

public final class DrawingSyncService {
    private static final Gson GSON = new Gson();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder TOKEN_ENCODER =
        Base64.getUrlEncoder().withoutPadding();
    private static final String CODE_ALPHABET =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final Duration SESSION_TTL = Duration.ofHours(6);
    private static final int MAX_HISTORY = 20_000;
    private static final long MAX_HISTORY_BYTES = 8L * 1024 * 1024;
    private static final long MAX_SNAPSHOT_BYTES = 4L * 1024 * 1024;
    private static final int SNAPSHOT_CHUNK_CHARS = 16 * 1024;
    private static final int MAX_MESSAGE_CHARS = 8 * 1024;
    private static final int MAX_POINTS_PER_EVENT = 128;
    private static final java.util.Set<String> ALLOWED_TYPES =
        java.util.Set.of(
            "canvas.stroke.begin",
            "canvas.stroke.points",
            "canvas.stroke.end",
            "canvas.undo",
            "canvas.redo",
            "canvas.clear"
        );

    public record Session(
        String drawingCode,
        String drawerToken,
        String createdAt,
        String expiresAt,
        long lastSequence
    ) {}

    public record PublicSession(
        String drawingCode,
        String expiresAt,
        long lastSequence
    ) {}

    private static final class State {
        private final String roundId;
        private final String code;
        private volatile String drawerToken;
        private volatile String drawerTokenHash;
        private final Instant createdAt;
        private final Instant expiresAt;
        private final AtomicLong sequence = new AtomicLong();
        private final ArrayList<String> history = new ArrayList<>();
        private long historyBytes;
        private long snapshotSequence;
        private String snapshotJson;
        private DrawingCanvasDocument document = new DrawingCanvasDocument();

        private State(
            String roundId,
            String code,
            String drawerToken,
            Instant createdAt,
            Instant expiresAt
        ) {
            this.roundId = roundId;
            this.code = code;
            this.drawerToken = drawerToken;
            this.drawerTokenHash = tokenHash(drawerToken);
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
        }
    }

    private final DatabaseAccess database;
    private final Map<String, State> states = new ConcurrentHashMap<>();
    private final Map<String, String> codeByRound =
        new ConcurrentHashMap<>();

    public DrawingSyncService() {
        this.database = null;
    }

    public DrawingSyncService(DatabaseAccess database) {
        this.database = database;
        restorePersistedSessions();
    }

    public Session createSession() {
        cleanupExpired();
        Instant now = Instant.now();
        return createState(null, now, now.plus(SESSION_TTL), false);
    }

    public Session createRoundSession(
        String roundId,
        Instant expiresAt
    ) {
        String normalizedRoundId = normalizeRoundId(roundId);
        if (normalizedRoundId.isBlank()) {
            throw new IllegalArgumentException("roundId is required");
        }

        cleanupExpired();
        State existing = stateForRound(normalizedRoundId);
        if (existing != null) {
            return session(existing);
        }

        Instant now = Instant.now();
        Instant normalizedExpiry = expiresAt == null
            ? now.plus(SESSION_TTL)
            : expiresAt;
        if (!normalizedExpiry.isAfter(now)) {
            throw new IllegalArgumentException(
                "drawing session expiry must be in the future"
            );
        }

        return createState(
            normalizedRoundId,
            now,
            normalizedExpiry,
            true
        );
    }

    public Session ensureRoundSession(
        String roundId,
        Instant expiresAt
    ) {
        String normalizedRoundId = normalizeRoundId(roundId);
        State existing = stateForRound(normalizedRoundId);
        if (existing != null) return session(existing);
        return createRoundSession(normalizedRoundId, expiresAt);
    }

    public Session reissueDrawerToken(String roundId) {
        State state = requiredStateForRound(roundId);
        synchronized (state) {
            String nextToken = randomToken(32);
            String nextHash = tokenHash(nextToken);
            persistTokenHash(state, nextHash);
            state.drawerToken = nextToken;
            state.drawerTokenHash = nextHash;
            return session(state);
        }
    }

    public String drawingCodeForRound(String roundId) {
        State state = stateForRound(normalizeRoundId(roundId));
        return state == null ? null : state.code;
    }

    public PublicSession findPublic(String code) {
        State state = activeState(code);
        return new PublicSession(
            state.code,
            state.expiresAt.toString(),
            state.sequence.get()
        );
    }

    public boolean isActive(String code) {
        try {
            activeState(code);
            return true;
        } catch (RuntimeException error) {
            return false;
        }
    }

    public boolean isAuthorizedDrawer(String code, String token) {
        if (token == null || token.isBlank()) return false;
        try {
            State state = activeState(code);
            return MessageDigest.isEqual(
                state.drawerTokenHash.getBytes(StandardCharsets.UTF_8),
                tokenHash(token).getBytes(StandardCharsets.UTF_8)
            );
        } catch (RuntimeException error) {
            return false;
        }
    }

    public String append(String code, String drawerToken, String rawJson) {
        State state = activeState(code);
        if (rawJson == null || rawJson.isBlank()) {
            throw new IllegalArgumentException(
                "drawing event is required"
            );
        }
        if (rawJson.length() > MAX_MESSAGE_CHARS) {
            throw new IllegalArgumentException(
                "drawing event is too large"
            );
        }

        JsonObject incoming;
        try {
            incoming = JsonParser.parseString(rawJson)
                .getAsJsonObject();
        } catch (Exception error) {
            throw new IllegalArgumentException(
                "drawing event must be a JSON object"
            );
        }

        String type = incoming.has("type")
            ? incoming.get("type").getAsString()
            : "";
        if (!ALLOWED_TYPES.contains(type)) {
            throw new IllegalArgumentException(
                "unsupported drawing event type"
            );
        }

        JsonElement payload = incoming.has("payload")
            ? incoming.get("payload")
            : new JsonObject();
        validatePayload(type, payload);

        synchronized (state) {
            // Check authorization under the same lock as token rotation and
            // session closure, not before a potentially delayed DB write.
            if (
                states.get(state.code) != state
                || drawerToken == null
                || !MessageDigest.isEqual(
                    state.drawerTokenHash.getBytes(StandardCharsets.UTF_8),
                    tokenHash(drawerToken).getBytes(StandardCharsets.UTF_8)
                )
            ) {
                throw new SecurityException("drawing write authorization failed");
            }
            long sequence = state.sequence.get() + 1L;
            Instant createdAt = Instant.now();

            var event = new JsonObject();
            event.addProperty("type", type);
            event.addProperty("drawingCode", state.code);
            event.addProperty("sequence", sequence);
            event.addProperty("createdAt", createdAt.toString());
            event.add("payload", payload.deepCopy());

            String canonical = GSON.toJson(event);
            long bytes = historyBytes(canonical);
            boolean compact = state.history.size() + 1 > MAX_HISTORY
                || state.historyBytes + bytes > MAX_HISTORY_BYTES;
            String nextSnapshot = null;
            DrawingCanvasDocument nextDocument = null;
            if (compact) {
                // Build the next state before writing; never drop old history
                // when the materialized snapshot is too large.
                nextDocument = DrawingCanvasDocument.restore(
                    state.document.snapshot()
                );
                nextDocument.apply(event);
                nextSnapshot = GSON.toJson(nextDocument.snapshot());
                if (historyBytes(nextSnapshot) > MAX_SNAPSHOT_BYTES) {
                    throw new IllegalStateException(
                        "drawing canvas exceeds compact snapshot capacity"
                    );
                }
            }
            persistEvent(state, sequence, canonical, createdAt, nextSnapshot);
            state.sequence.set(sequence);
            if (compact) {
                state.document = nextDocument;
                state.snapshotJson = nextSnapshot;
                state.snapshotSequence = sequence;
                state.history.clear();
                state.historyBytes = 0;
            } else {
                state.document.apply(event);
                state.history.add(canonical);
                state.historyBytes += bytes;
            }
            return canonical;
        }
    }

    private static void validatePayload(
        String type,
        JsonElement payload
    ) {
        if (payload == null || !payload.isJsonObject()) {
            throw new IllegalArgumentException(
                "drawing event payload must be an object"
            );
        }

        JsonObject object = payload.getAsJsonObject();
        switch (type) {
            case "canvas.stroke.begin" -> {
                JsonElement rawStroke = object.get("stroke");
                if (rawStroke == null || !rawStroke.isJsonObject()) {
                    throw new IllegalArgumentException(
                        "stroke.begin requires a stroke object"
                    );
                }
                JsonObject stroke = rawStroke.getAsJsonObject();
                requiredText(stroke, "strokeId", 128);
                validatePoints(stroke.get("points"), 1);
            }
            case "canvas.stroke.points" -> {
                requiredText(object, "strokeId", 128);
                validatePoints(object.get("points"), 1);
            }
            case "canvas.stroke.end" ->
                requiredText(object, "strokeId", 128);
            case "canvas.undo", "canvas.redo", "canvas.clear" -> {
                // No additional payload fields are required.
            }
            default -> throw new IllegalArgumentException(
                "unsupported drawing event type"
            );
        }
    }

    private static String requiredText(
        JsonObject object,
        String key,
        int maxLength
    ) {
        JsonElement value = object.get(key);
        if (
            value == null
                || !value.isJsonPrimitive()
                || !value.getAsJsonPrimitive().isString()
        ) {
            throw new IllegalArgumentException(
                key + " must be a string"
            );
        }
        String text = value.getAsString().trim();
        if (text.isEmpty() || text.length() > maxLength) {
            throw new IllegalArgumentException(
                key + " length is invalid"
            );
        }
        return text;
    }

    private static void validatePoints(
        JsonElement rawPoints,
        int minimum
    ) {
        if (rawPoints == null || !rawPoints.isJsonArray()) {
            throw new IllegalArgumentException(
                "drawing points must be an array"
            );
        }
        var points = rawPoints.getAsJsonArray();
        if (
            points.size() < minimum
                || points.size() > MAX_POINTS_PER_EVENT
        ) {
            throw new IllegalArgumentException(
                "drawing point batch must contain "
                    + minimum + ".." + MAX_POINTS_PER_EVENT
                    + " points"
            );
        }

        for (JsonElement rawPoint : points) {
            if (rawPoint == null || !rawPoint.isJsonObject()) {
                throw new IllegalArgumentException(
                    "drawing point must be an object"
                );
            }
            JsonObject point = rawPoint.getAsJsonObject();
            requireUnitNumber(point, "x");
            requireUnitNumber(point, "y");
            if (point.has("pressure")) {
                requireUnitNumber(point, "pressure");
            }
        }
    }

    private static double requireUnitNumber(
        JsonObject object,
        String key
    ) {
        JsonElement value = object.get(key);
        if (value == null || !value.isJsonPrimitive()) {
            throw new IllegalArgumentException(
                key + " must be numeric"
            );
        }

        final double number;
        try {
            number = value.getAsDouble();
        } catch (RuntimeException error) {
            throw new IllegalArgumentException(
                key + " must be numeric"
            );
        }
        if (!Double.isFinite(number) || number < 0 || number > 1) {
            throw new IllegalArgumentException(
                key + " must be within 0..1"
            );
        }
        return number;
    }

    private static long historyBytes(String eventJson) {
        return eventJson.getBytes(StandardCharsets.UTF_8).length;
    }

    /** Reconnect starts from an entire snapshot, never orphaned point events. */
    public List<String> history(String code) {
        State state = activeState(code);
        synchronized (state) {
            var replay = new ArrayList<String>();
            if (state.snapshotJson != null) {
                int length = state.snapshotJson.length();
                var parts = new ArrayList<String>();
                for (int offset = 0; offset < length;) {
                    int end = Math.min(length, offset + SNAPSHOT_CHUNK_CHARS);
                    // WebSocket UTF-8 encoding must not split a surrogate pair.
                    if (end < length
                        && Character.isHighSurrogate(state.snapshotJson.charAt(end - 1))
                        && Character.isLowSurrogate(state.snapshotJson.charAt(end))) {
                        end -= 1;
                    }
                    parts.add(state.snapshotJson.substring(offset, end));
                    offset = end;
                }
                int chunks = parts.size();
                var begin = new JsonObject();
                begin.addProperty("type", "canvas.snapshot.begin");
                begin.addProperty("sequence", state.snapshotSequence);
                begin.addProperty("chunks", chunks);
                replay.add(GSON.toJson(begin));
                for (int index = 0; index < chunks; index++) {
                    var part = new JsonObject();
                    part.addProperty("type", "canvas.snapshot.chunk");
                    part.addProperty("sequence", state.snapshotSequence);
                    part.addProperty("index", index);
                    part.addProperty("data", parts.get(index));
                    replay.add(GSON.toJson(part));
                }
                var finish = new JsonObject();
                finish.addProperty("type", "canvas.snapshot.end");
                finish.addProperty("sequence", state.snapshotSequence);
                replay.add(GSON.toJson(finish));
            }
            replay.addAll(state.history);
            return List.copyOf(replay);
        }
    }

    public boolean closeSession(String code) {
        String normalized = normalizeCode(code);
        if (normalized.isBlank()) return false;

        State state = states.get(normalized);
        if (state == null) return false;
        synchronized (state) {
            if (states.get(normalized) != state) return false;
            // Persist first: if deletion fails, keep the session addressable
            // so the operator can retry closure rather than losing its state.
            if (state.roundId != null) persistClosed(state);
            if (!states.remove(normalized, state)) return false;
            if (state.roundId != null) {
                codeByRound.remove(state.roundId, state.code);
            }
            return true;
        }
    }

    public boolean closeSessionForRound(String roundId) {
        String normalizedRoundId = normalizeRoundId(roundId);
        String code = codeByRound.get(normalizedRoundId);
        return code != null && closeSession(code);
    }

    public int activeSessionCount() {
        cleanupExpired();
        return states.size();
    }

    public int persistentRoundSessionCount() {
        cleanupExpired();
        return codeByRound.size();
    }

    private Session createState(
        String roundId,
        Instant createdAt,
        Instant expiresAt,
        boolean persist
    ) {
        for (int attempt = 0; attempt < 128; attempt += 1) {
            String code = randomCode();
            if (states.containsKey(code)) continue;

            String token = randomToken(32);
            var state = new State(
                roundId,
                code,
                token,
                createdAt,
                expiresAt
            );

            boolean shouldPersist =
                persist && database != null;
            if (shouldPersist && !persistNewState(state)) {
                continue;
            }

            if (states.putIfAbsent(code, state) != null) {
                if (shouldPersist) deletePersistedState(roundId);
                continue;
            }
            if (roundId != null) {
                codeByRound.put(roundId, code);
            }
            return session(state);
        }
        throw new IllegalStateException(
            "failed to allocate drawing code"
        );
    }

    private State activeState(String rawCode) {
        cleanupExpired();
        String code = normalizeCode(rawCode);
        State state = states.get(code);
        if (
            state == null
            || !state.expiresAt.isAfter(Instant.now())
        ) {
            if (state != null) closeSession(state.code);
            throw new NoSuchElementException(
                "drawing sync session not found"
            );
        }
        return state;
    }

    private State stateForRound(String roundId) {
        if (roundId == null || roundId.isBlank()) return null;
        cleanupExpired();
        String code = codeByRound.get(roundId);
        if (code == null) return null;
        State state = states.get(code);
        if (
            state == null
            || !state.expiresAt.isAfter(Instant.now())
        ) {
            if (state != null) closeSession(state.code);
            return null;
        }
        return state;
    }

    private State requiredStateForRound(String roundId) {
        String normalizedRoundId = normalizeRoundId(roundId);
        State state = stateForRound(normalizedRoundId);
        if (state == null) {
            throw new NoSuchElementException(
                "drawing sync session for round not found"
            );
        }
        return state;
    }

    private void cleanupExpired() {
        Instant now = Instant.now();
        for (State state : List.copyOf(states.values())) {
            if (!state.expiresAt.isAfter(now)) {
                closeSession(state.code);
            }
        }
    }

    private void restorePersistedSessions() {
        if (database == null) return;

        Instant now = Instant.now();
        var restored = new ArrayList<State>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT round_id, drawing_code, created_at,
                        expires_at, last_sequence,
                        snapshot_sequence, snapshot_json
                 FROM drawing_guess_canvas_session
                 WHERE state = 'ACTIVE'
                 ORDER BY created_at
                 """);
             var rows = statement.executeQuery()) {
            while (rows.next()) {
                String roundId = rows.getString("round_id");
                String code = rows.getString("drawing_code");
                Instant createdAt = Instant.parse(
                    rows.getString("created_at")
                );
                Instant expiresAt = Instant.parse(
                    rows.getString("expires_at")
                );

                if (!expiresAt.isAfter(now)) {
                    deletePersistedState(roundId);
                    continue;
                }

                // Rotate on process start. Any token issued by the previous
                // process immediately stops authorizing writes.
                String token = randomToken(32);
                var state = new State(
                    roundId,
                    code,
                    token,
                    createdAt,
                    expiresAt
                );
                state.sequence.set(
                    rows.getLong("last_sequence")
                );
                state.snapshotSequence = rows.getLong("snapshot_sequence");
                state.snapshotJson = rows.getString("snapshot_json");
                if (state.snapshotJson != null) {
                    try {
                        state.document = DrawingCanvasDocument.restore(
                            JsonParser.parseString(state.snapshotJson)
                                .getAsJsonObject()
                        );
                    } catch (RuntimeException error) {
                        throw new SQLException(
                            "corrupt persisted drawing canvas snapshot", error
                        );
                    }
                }
                restoreHistory(state);
                persistTokenHash(state, state.drawerTokenHash);
                restored.add(state);
            }
        } catch (SQLException error) {
            throw new IllegalStateException(
                "failed to restore drawing sync sessions",
                error
            );
        }

        for (State state : restored) {
            states.put(state.code, state);
            codeByRound.put(state.roundId, state.code);
        }
    }

    private void restoreHistory(State state) throws SQLException {
        var newestFirst = new ArrayList<String>();
        long retainedBytes = 0;
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT event_json
                 FROM drawing_guess_canvas_event
                 WHERE round_id = ?
                 ORDER BY sequence DESC
                 LIMIT ?
                 """)) {
            statement.setString(1, state.roundId);
            statement.setInt(2, MAX_HISTORY);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    String eventJson = rows.getString("event_json");
                    long eventBytes = historyBytes(eventJson);
                    if (
                        !newestFirst.isEmpty()
                            && retainedBytes + eventBytes
                                > MAX_HISTORY_BYTES
                    ) {
                        break;
                    }
                    newestFirst.add(eventJson);
                    retainedBytes += eventBytes;
                }
            }
        }

        Collections.reverse(newestFirst);
        state.history.addAll(newestFirst);
        state.historyBytes = retainedBytes;
        for (String canonical : state.history) {
            state.document.apply(
                JsonParser.parseString(canonical).getAsJsonObject()
            );
        }
    }

    private boolean persistNewState(State state) {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 INSERT INTO drawing_guess_canvas_session(
                   round_id, drawing_code, drawer_token_hash,
                   created_at, expires_at, last_sequence, state
                 ) VALUES (?, ?, ?, ?, ?, 0, 'ACTIVE')
                 """)) {
            statement.setString(1, state.roundId);
            statement.setString(2, state.code);
            statement.setString(3, state.drawerTokenHash);
            statement.setString(4, state.createdAt.toString());
            statement.setString(5, state.expiresAt.toString());
            statement.executeUpdate();
            return true;
        } catch (SQLException error) {
            String message = error.getMessage();
            if (
                message != null
                && message.toLowerCase(Locale.ROOT)
                    .contains("unique")
            ) {
                return false;
            }
            throw new IllegalStateException(
                "failed to persist drawing sync session",
                error
            );
        }
    }

    private void persistEvent(
        State state,
        long sequence,
        String eventJson,
        Instant createdAt,
        String snapshotJson
    ) {
        if (database == null || state.roundId == null) return;
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                // The compacted snapshot already contains this event.
                if (snapshotJson == null) {
                    try (var statement = connection.prepareStatement("""
                        INSERT INTO drawing_guess_canvas_event(
                          round_id, sequence, event_json, created_at
                        ) VALUES (?, ?, ?, ?)
                        """)) {
                        statement.setString(1, state.roundId);
                        statement.setLong(2, sequence);
                        statement.setString(3, eventJson);
                        statement.setString(4, createdAt.toString());
                        statement.executeUpdate();
                    }
                }

                String update = snapshotJson == null
                    ? """
                        UPDATE drawing_guess_canvas_session
                        SET last_sequence = ?
                        WHERE round_id = ? AND state = 'ACTIVE'
                        """
                    : """
                        UPDATE drawing_guess_canvas_session
                        SET last_sequence = ?, snapshot_sequence = ?,
                            snapshot_json = ?
                        WHERE round_id = ? AND state = 'ACTIVE'
                        """;
                try (var statement = connection.prepareStatement(update)) {
                    statement.setLong(1, sequence);
                    if (snapshotJson == null) {
                        statement.setString(2, state.roundId);
                    } else {
                        statement.setLong(2, sequence);
                        statement.setString(3, snapshotJson);
                        statement.setString(4, state.roundId);
                    }
                    if (statement.executeUpdate() != 1) {
                        throw new IllegalStateException(
                            "drawing session is no longer active"
                        );
                    }
                }
                if (snapshotJson != null) {
                    try (var statement = connection.prepareStatement("""
                        DELETE FROM drawing_guess_canvas_event
                        WHERE round_id = ?
                        """)) {
                        statement.setString(1, state.roundId);
                        statement.executeUpdate();
                    }
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                throw error;
            } finally {
                connection.setAutoCommit(true);
            }
        } catch (Exception error) {
            throw new IllegalStateException(
                "failed to persist drawing event", error
            );
        }
    }

    private void persistTokenHash(State state, String tokenHash) {
        if (database == null || state.roundId == null) return;
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE drawing_guess_canvas_session
                 SET drawer_token_hash = ?
                 WHERE round_id = ? AND state = 'ACTIVE'
                 """)) {
            statement.setString(1, tokenHash);
            statement.setString(2, state.roundId);
            if (statement.executeUpdate() != 1) {
                throw new NoSuchElementException(
                    "persistent drawing session is not active"
                );
            }
        } catch (SQLException error) {
            throw new IllegalStateException(
                "failed to rotate drawing token",
                error
            );
        }
    }

    private void persistClosed(State state) {
        if (database == null || state.roundId == null) return;
        deletePersistedState(state.roundId);
    }

    private void deletePersistedState(String roundId) {
        if (database == null || roundId == null) return;
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 DELETE FROM drawing_guess_canvas_session
                 WHERE round_id = ?
                 """)) {
            statement.setString(1, roundId);
            statement.executeUpdate();
        } catch (SQLException error) {
            throw new IllegalStateException(
                "failed to rollback drawing session allocation",
                error
            );
        }
    }

    private static Session session(State state) {
        return new Session(
            state.code,
            state.drawerToken,
            state.createdAt.toString(),
            state.expiresAt.toString(),
            state.sequence.get()
        );
    }

    private static String normalizeCode(String value) {
        return value == null
            ? ""
            : value.trim().toUpperCase(Locale.ROOT);
    }

    private static String normalizeRoundId(String value) {
        return value == null ? "" : value.trim();
    }

    private static String randomCode() {
        StringBuilder code = new StringBuilder(6);
        for (int index = 0; index < 6; index += 1) {
            code.append(
                CODE_ALPHABET.charAt(
                    RANDOM.nextInt(CODE_ALPHABET.length())
                )
            );
        }
        return code.toString();
    }

    private static String randomToken(int byteCount) {
        byte[] bytes = new byte[byteCount];
        RANDOM.nextBytes(bytes);
        return TOKEN_ENCODER.encodeToString(bytes);
    }

    private static String tokenHash(String token) {
        try {
            return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(
                    token.getBytes(StandardCharsets.UTF_8)
                )
            );
        } catch (Exception error) {
            throw new IllegalStateException(
                "failed to hash drawer token",
                error
            );
        }
    }
}
