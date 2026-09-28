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
    private static final int MAX_MESSAGE_CHARS = 96 * 1024;
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
        if (
            drawerToken == null
            || !MessageDigest.isEqual(
                state.drawerTokenHash.getBytes(StandardCharsets.UTF_8),
                tokenHash(drawerToken).getBytes(StandardCharsets.UTF_8)
            )
        ) {
            throw new SecurityException(
                "drawing write authorization failed"
            );
        }
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

        synchronized (state) {
            long sequence = state.sequence.get() + 1L;
            Instant createdAt = Instant.now();

            var event = new JsonObject();
            event.addProperty("type", type);
            event.addProperty("drawingCode", state.code);
            event.addProperty("sequence", sequence);
            event.addProperty("createdAt", createdAt.toString());
            event.add("payload", payload.deepCopy());

            String canonical = GSON.toJson(event);
            persistEvent(state, sequence, canonical, createdAt);

            state.sequence.set(sequence);
            state.history.add(canonical);
            if (state.history.size() > MAX_HISTORY) {
                int removeCount =
                    state.history.size() - MAX_HISTORY;
                state.history.subList(0, removeCount).clear();
            }
            return canonical;
        }
    }

    public List<String> history(String code) {
        State state = activeState(code);
        synchronized (state) {
            return List.copyOf(state.history);
        }
    }

    public boolean closeSession(String code) {
        String normalized = normalizeCode(code);
        if (normalized.isBlank()) return false;

        State state = states.remove(normalized);
        if (state == null) return false;

        if (state.roundId != null) {
            codeByRound.remove(state.roundId, state.code);
            persistClosed(state, Instant.now());
        }
        return true;
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
                        expires_at, last_sequence
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
                    markPersistedClosed(roundId, now);
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
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT event_json
                 FROM drawing_guess_canvas_event
                 WHERE round_id = ?
                 ORDER BY sequence
                 """)) {
            statement.setString(1, state.roundId);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    state.history.add(
                        rows.getString("event_json")
                    );
                }
            }
        }
        if (state.history.size() > MAX_HISTORY) {
            int removeCount =
                state.history.size() - MAX_HISTORY;
            state.history.subList(0, removeCount).clear();
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
        Instant createdAt
    ) {
        if (database == null || state.roundId == null) return;

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
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

                try (var statement = connection.prepareStatement("""
                    UPDATE drawing_guess_canvas_session
                    SET last_sequence = ?
                    WHERE round_id = ? AND state = 'ACTIVE'
                    """)) {
                    statement.setLong(1, sequence);
                    statement.setString(2, state.roundId);
                    if (statement.executeUpdate() != 1) {
                        throw new IllegalStateException(
                            "drawing session is no longer active"
                        );
                    }
                }

                long cutoff = sequence - MAX_HISTORY;
                if (cutoff > 0) {
                    try (var statement = connection.prepareStatement("""
                        DELETE FROM drawing_guess_canvas_event
                        WHERE round_id = ? AND sequence <= ?
                        """)) {
                        statement.setString(1, state.roundId);
                        statement.setLong(2, cutoff);
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
                "failed to persist drawing event",
                error
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

    private void persistClosed(State state, Instant closedAt) {
        if (database == null || state.roundId == null) return;
        markPersistedClosed(state.roundId, closedAt);
    }

    private void markPersistedClosed(
        String roundId,
        Instant closedAt
    ) {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE drawing_guess_canvas_session
                 SET state = 'CLOSED', closed_at = ?
                 WHERE round_id = ? AND state = 'ACTIVE'
                 """)) {
            statement.setString(1, closedAt.toString());
            statement.setString(2, roundId);
            statement.executeUpdate();
        } catch (SQLException error) {
            throw new IllegalStateException(
                "failed to close persistent drawing session",
                error
            );
        }
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
