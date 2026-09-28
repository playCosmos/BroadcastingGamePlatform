package io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;

public final class ViewerDrawService {
    private static final Gson GSON = new Gson();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String RNG_ALGORITHM = "SHA1PRNG-compatible SecureRandom / rejection-free Fisher-Yates";
    private static final int MAX_ENTRIES = 10000;
    private static final int MAX_NUMBER = 999;
    private static final int MAX_NUMBER_DRAW_COUNT = 7;

    private final DatabaseAccess database;

    public ViewerDrawService(DatabaseAccess database) {
        this.database = database;
    }

    public record DrawEntry(
        String entryId,
        String provider,
        String userId,
        String displayName,
        String label
    ) {}

    public record Session(
        String sessionId,
        String publicCode,
        String name,
        String mode,
        String entrySource,
        String state,
        Map<String, Object> config,
        String frozenEntryHash,
        int entryCount,
        String createdAt,
        String updatedAt,
        String completedAt,
        List<DrawEntry> entries,
        Object result
    ) {}

    public Session create(
        String name,
        String mode,
        List<String> manualEntries,
        Map<String, Object> config
    ) throws SQLException {
        String normalizedMode = normalizeMode(mode);
        String sessionId = UUID.randomUUID().toString();
        String publicCode = createPublicCode();
        String now = Instant.now().toString();
        String normalizedName = name == null || name.isBlank()
            ? defaultName(normalizedMode)
            : name.trim();
        Map<String, Object> normalizedConfig = normalizeConfig(
            normalizedMode,
            config == null ? Map.of() : config
        );
        List<String> entries = normalizedMode.equals("RANDOM")
            ? normalizeManualEntries(manualEntries)
            : List.of();

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO viewer_draw_session(
                        session_id, public_code, name, mode, entry_source, state,
                        config_json, entry_count, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'MANUAL_LIST', 'DRAFT', ?, ?, ?, ?)
                    """)) {
                    statement.setString(1, sessionId);
                    statement.setString(2, publicCode);
                    statement.setString(3, normalizedName);
                    statement.setString(4, normalizedMode);
                    statement.setString(5, GSON.toJson(normalizedConfig));
                    statement.setInt(6, entries.size());
                    statement.setString(7, now);
                    statement.setString(8, now);
                    statement.executeUpdate();
                }

                int index = 0;
                for (String displayName : entries) {
                    try (var statement = connection.prepareStatement("""
                        INSERT INTO viewer_draw_entry(
                            session_id, entry_index, entry_id,
                            display_name, label
                        ) VALUES (?, ?, ?, ?, ?)
                        """)) {
                        statement.setString(1, sessionId);
                        statement.setInt(2, index++);
                        statement.setString(3, UUID.randomUUID().toString());
                        statement.setString(4, displayName);
                        statement.setString(5, displayName);
                        statement.executeUpdate();
                    }
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException("failed to create viewer draw session", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
        return find(sessionId);
    }

    public List<Session> recent(int limit) throws SQLException {
        int normalizedLimit = Math.max(1, Math.min(100, limit));
        var ids = new ArrayList<String>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT session_id
                 FROM viewer_draw_session
                 ORDER BY updated_at DESC
                 LIMIT ?
                 """)) {
            statement.setInt(1, normalizedLimit);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) ids.add(rows.getString(1));
            }
        }
        var result = new ArrayList<Session>();
        for (String id : ids) result.add(find(id));
        return List.copyOf(result);
    }

    public Session find(String sessionId) throws SQLException {
        Map<String, Object> config;
        String publicCode;
        String name;
        String mode;
        String entrySource;
        String state;
        String hash;
        int entryCount;
        String createdAt;
        String updatedAt;
        String completedAt;

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT public_code, name, mode, entry_source, state, config_json,
                        frozen_entry_hash, entry_count, created_at,
                        updated_at, completed_at
                 FROM viewer_draw_session
                 WHERE session_id = ?
                 """)) {
            statement.setString(1, sessionId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) throw new NoSuchElementException("viewer draw session not found");
                publicCode = rows.getString("public_code");
                name = rows.getString("name");
                mode = rows.getString("mode");
                entrySource = rows.getString("entry_source");
                state = rows.getString("state");
                config = GSON.fromJson(
                    rows.getString("config_json"),
                    new TypeToken<LinkedHashMap<String, Object>>() {}.getType()
                );
                hash = rows.getString("frozen_entry_hash");
                entryCount = rows.getInt("entry_count");
                createdAt = rows.getString("created_at");
                updatedAt = rows.getString("updated_at");
                completedAt = rows.getString("completed_at");
            }
        }

        var entries = new ArrayList<DrawEntry>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT entry_id, provider_id, user_id, display_name, label
                 FROM viewer_draw_entry
                 WHERE session_id = ?
                 ORDER BY entry_index
                 """)) {
            statement.setString(1, sessionId);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    entries.add(new DrawEntry(
                        rows.getString("entry_id"),
                        rows.getString("provider_id"),
                        rows.getString("user_id"),
                        rows.getString("display_name"),
                        rows.getString("label")
                    ));
                }
            }
        }

        Object drawResult = null;
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT result_json FROM viewer_draw_result WHERE session_id = ?
                 """)) {
            statement.setString(1, sessionId);
            try (var rows = statement.executeQuery()) {
                if (rows.next()) {
                    drawResult = GSON.fromJson(rows.getString(1), Object.class);
                }
            }
        }

        return new Session(
            sessionId, publicCode, name, mode, entrySource, state, config, hash,
            entryCount, createdAt, updatedAt, completedAt,
            List.copyOf(entries), drawResult
        );
    }

    public Session findByPublicCode(String publicCode) throws SQLException {
        String normalized = normalizePublicCode(publicCode);
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT session_id
                 FROM viewer_draw_session
                 WHERE public_code = ?
                 """)) {
            statement.setString(1, normalized);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new NoSuchElementException("viewer draw session not found");
                }
                return find(rows.getString(1));
            }
        }
    }

    public Session freeze(String sessionId) throws SQLException {
        Session session = find(sessionId);
        if (!"DRAFT".equals(session.state())) {
            if ("FROZEN".equals(session.state())) return session;
            throw new IllegalStateException("only DRAFT sessions can be frozen");
        }

        validateBeforeFreeze(session);
        String hash = frozenHash(session);
        String now = Instant.now().toString();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE viewer_draw_session
                 SET state = 'FROZEN', frozen_entry_hash = ?, updated_at = ?
                 WHERE session_id = ? AND state = 'DRAFT'
                 """)) {
            statement.setString(1, hash);
            statement.setString(2, now);
            statement.setString(3, sessionId);
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException("session state changed before freeze");
            }
        }
        return find(sessionId);
    }

    public Session start(String sessionId) throws SQLException {
        Session session = find(sessionId);
        if (!"FROZEN".equals(session.state())) {
            throw new IllegalStateException("session must be FROZEN before draw");
        }

        Object result = switch (session.mode()) {
            case "RANDOM" -> runRandomDraw(session);
            case "NUMBER" -> runNumberDraw(session);
            default -> throw new IllegalStateException("unsupported draw mode: " + session.mode());
        };

        String now = Instant.now().toString();
        var audit = new LinkedHashMap<String, Object>();
        audit.put("sessionId", sessionId);
        audit.put("mode", session.mode());
        audit.put("entrySource", session.entrySource());
        audit.put("frozenEntryHash", session.frozenEntryHash());
        audit.put("entryCount", session.entryCount());
        audit.put("rngAlgorithm", RNG_ALGORITHM);
        audit.put("completedAt", now);

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO viewer_draw_result(
                        session_id, result_json, rng_algorithm, audit_json, created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """)) {
                    statement.setString(1, sessionId);
                    statement.setString(2, GSON.toJson(result));
                    statement.setString(3, RNG_ALGORITHM);
                    statement.setString(4, GSON.toJson(audit));
                    statement.setString(5, now);
                    statement.executeUpdate();
                }
                try (var statement = connection.prepareStatement("""
                    UPDATE viewer_draw_session
                    SET state = 'COMPLETED', completed_at = ?, updated_at = ?
                    WHERE session_id = ? AND state = 'FROZEN'
                    """)) {
                    statement.setString(1, now);
                    statement.setString(2, now);
                    statement.setString(3, sessionId);
                    if (statement.executeUpdate() != 1) {
                        throw new IllegalStateException("session state changed before draw completion");
                    }
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException("viewer draw failed", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
        return find(sessionId);
    }

    private static Map<String, Object> runRandomDraw(Session session) {
        int winnerCount = intConfig(session.config(), "winnerCount", 1);
        var pool = new ArrayList<>(session.entries());
        secureShuffle(pool);
        var winners = pool.subList(0, winnerCount);

        var result = new LinkedHashMap<String, Object>();
        result.put("mode", "RANDOM");
        result.put("winnerCount", winnerCount);
        result.put("winners", List.copyOf(winners));
        return result;
    }

    private static Map<String, Object> runNumberDraw(Session session) {
        int max = intConfig(session.config(), "maxNumber", 45);
        int count = intConfig(session.config(), "drawCount", 7);
        var pool = new ArrayList<Integer>(max);
        for (int number = 1; number <= max; number++) pool.add(number);
        secureShuffle(pool);
        List<Integer> numbers = new ArrayList<>(pool.subList(0, count));

        var result = new LinkedHashMap<String, Object>();
        result.put("mode", "NUMBER");
        result.put("maxNumber", max);
        result.put("drawCount", count);
        result.put("numbers", List.copyOf(numbers));
        return result;
    }

    private static <T> void secureShuffle(List<T> values) {
        for (int i = 0; i < values.size() - 1; i++) {
            int offset = RANDOM.nextInt(values.size() - i);
            Collections.swap(values, i, i + offset);
        }
    }

    private static void validateBeforeFreeze(Session session) {
        if ("RANDOM".equals(session.mode())) {
            int winnerCount = intConfig(session.config(), "winnerCount", 1);
            if (session.entries().isEmpty()) {
                throw new IllegalStateException("at least one entry is required");
            }
            if (winnerCount < 1 || winnerCount > session.entries().size()) {
                throw new IllegalStateException("winnerCount must be within entry count");
            }
            return;
        }

        int max = intConfig(session.config(), "maxNumber", 45);
        int count = intConfig(session.config(), "drawCount", 7);
        if (max < 1 || max > MAX_NUMBER) {
            throw new IllegalStateException("maxNumber must be 1.." + MAX_NUMBER);
        }
        if (count < 1 || count > Math.min(MAX_NUMBER_DRAW_COUNT, max)) {
            throw new IllegalStateException("drawCount must be 1.." + Math.min(MAX_NUMBER_DRAW_COUNT, max));
        }
    }

    private static Map<String, Object> normalizeConfig(String mode, Map<String, Object> raw) {
        var result = new LinkedHashMap<String, Object>();
        if ("RANDOM".equals(mode)) {
            result.put("winnerCount", intConfig(raw, "winnerCount", 1));
        } else {
            result.put("maxNumber", intConfig(raw, "maxNumber", 45));
            result.put("drawCount", intConfig(raw, "drawCount", 7));
        }
        return result;
    }

    private static int intConfig(Map<String, Object> config, String key, int fallback) {
        Object value = config.get(key);
        if (value instanceof Number number) return number.intValue();
        if (value instanceof String text) {
            try { return Integer.parseInt(text.trim()); }
            catch (NumberFormatException ignored) {}
        }
        return fallback;
    }

    private static List<String> normalizeManualEntries(List<String> raw) {
        if (raw == null) return List.of();
        var result = new ArrayList<String>();
        var seen = new java.util.LinkedHashSet<String>();
        for (String value : raw) {
            if (value == null) continue;
            String normalized = value.trim();
            if (normalized.isBlank()) continue;
            if (seen.add(normalized)) result.add(normalized);
            if (result.size() > MAX_ENTRIES) {
                throw new IllegalArgumentException("too many entries; max=" + MAX_ENTRIES);
            }
        }
        return List.copyOf(result);
    }

    private static String frozenHash(Session session) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            digest.update(session.mode().getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            digest.update(GSON.toJson(session.config()).getBytes(StandardCharsets.UTF_8));
            for (DrawEntry entry : session.entries()) {
                digest.update((byte) 0);
                digest.update(entry.entryId().getBytes(StandardCharsets.UTF_8));
                digest.update((byte) 0);
                digest.update(entry.label().getBytes(StandardCharsets.UTF_8));
            }
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (Exception error) {
            throw new IllegalStateException("failed to hash frozen entry set", error);
        }
    }

    private static String createPublicCode() {
        final String alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        StringBuilder value = new StringBuilder(6);
        for (int index = 0; index < 6; index++) {
            value.append(alphabet.charAt(RANDOM.nextInt(alphabet.length())));
        }
        return value.toString();
    }

    private static String normalizePublicCode(String value) {
        return value == null
            ? ""
            : value.trim().toUpperCase(Locale.ROOT);
    }

    private static String normalizeMode(String mode) {
        String normalized = mode == null ? "" : mode.trim().toUpperCase(Locale.ROOT);
        if (!normalized.equals("RANDOM") && !normalized.equals("NUMBER")) {
            throw new IllegalArgumentException("mode must be RANDOM or NUMBER");
        }
        return normalized;
    }

    private static String defaultName(String mode) {
        return mode.equals("NUMBER") ? "번호 추첨" : "시청자 랜덤 추첨";
    }
}
