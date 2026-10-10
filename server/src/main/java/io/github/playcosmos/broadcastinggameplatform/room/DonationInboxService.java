package io.github.playcosmos.broadcastinggameplatform.room;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.platform.events.DonationEvent;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Objects;

/**
 * Durable ingress for SOOP donations. A processed event may be replayed after
 * acknowledgement fails; BoardGameRuntimeEngine's per-room fingerprint is
 * therefore the idempotency boundary for gameplay changes.
 */
public final class DonationInboxService {
    private static final Gson GSON = new Gson();
    private static final java.lang.reflect.Type ROOM_IDS_TYPE =
        new TypeToken<List<String>>() {}.getType();
    private static final int MAX_PENDING = 10000;
    private static final int MAX_VOLATILE_BUFFER = 1024;
    private static final int MAX_EVENT_JSON_BYTES = 128 * 1024;
    private static final long DONE_RETENTION_MS = 7L * 24 * 60 * 60 * 1000;
    private static final long PRUNE_INTERVAL_MS = 60L * 60 * 1000;

    @FunctionalInterface
    interface Matcher {
        List<String> matchingRooms(DonationEvent event) throws SQLException;
    }

    @FunctionalInterface
    interface Processor {
        void process(DonationEvent event, List<String> roomIds) throws SQLException;
    }

    private final DatabaseAccess database;
    private final Matcher matcher;
    private final Processor processor;
    private final LinkedHashMap<String, DonationEvent> emergencyBuffer =
        new LinkedHashMap<>();
    private long lastPruneMs;

    public DonationInboxService(DatabaseAccess database, BoardGameRuntimeEngine runtime) {
        this(
            database,
            runtime::matchingRoomIds,
            (event, rooms) -> runtime.processForRooms(event, rooms)
        );
    }

    DonationInboxService(DatabaseAccess database, Matcher matcher, Processor processor) {
        this.database = Objects.requireNonNull(database, "database");
        this.matcher = Objects.requireNonNull(matcher, "matcher");
        this.processor = Objects.requireNonNull(processor, "processor");
    }

    /** Accept before invoking the game engine. A disk outage uses a bounded
     * volatile buffer, which cannot survive a process crash. */
    public synchronized void accept(DonationEvent donation) throws SQLException {
        Objects.requireNonNull(donation, "donation");
        String key = inboxKey(donation);
        if (!emergencyBuffer.isEmpty()) {
            if (!flushEmergencyBuffer()) {
                buffer(key, donation);
                return;
            }
        }
        try {
            persist(key, donation);
        } catch (SQLException error) {
            buffer(key, donation);
            System.err.println(
                "[donation-inbox] database unavailable, volatile buffer="
                    + emergencyBuffer.size() + " (not crash durable): "
                    + safeMessage(error)
            );
        }
    }

    public synchronized int volatileBufferedCount() {
        return emergencyBuffer.size();
    }

    /** At startup, retry the oldest in-flight event even when it was backed off. */
    public synchronized int recoverAfterRestart() throws SQLException {
        return drainBatch(256, true);
    }

    public synchronized int drainBatch(int maximum) throws SQLException {
        return drainBatch(maximum, false);
    }

    private int drainBatch(int maximum, boolean forceFirstRetry) throws SQLException {
        if (!flushEmergencyBuffer()) return 0;
        int processed = 0;
        int limit = Math.max(1, Math.min(256, maximum));
        while (processed < limit) {
            Entry entry = oldestPending();
            if (entry == null) break;
            if (!forceFirstRetry
                && entry.nextAttemptAtMs() > System.currentTimeMillis()) break;
            try {
                processor.process(entry.donation(), entry.roomIds());
                markDone(entry.key());
                processed++;
            } catch (Exception error) {
                markRetry(entry, error);
                System.err.println(
                    "[donation-inbox] processing failed, retained for retry"
                        + " attempts=" + (entry.attempts() + 1)
                        + ": " + safeMessage(error)
                );
                break; // Preserve ingress order across temporary failures.
            }
        }
        pruneDoneOccasionally();
        return processed;
    }

    private boolean flushEmergencyBuffer() {
        var iterator = emergencyBuffer.entrySet().iterator();
        while (iterator.hasNext()) {
            var entry = iterator.next();
            try {
                persist(entry.getKey(), entry.getValue());
                iterator.remove();
            } catch (SQLException error) {
                return false;
            }
        }
        return true;
    }

    private void buffer(String key, DonationEvent event) {
        if (!emergencyBuffer.containsKey(key)
            && emergencyBuffer.size() >= MAX_VOLATILE_BUFFER) {
            throw new IllegalStateException(
                "donation emergency buffer is full; event cannot be guaranteed"
            );
        }
        emergencyBuffer.putIfAbsent(key, event);
    }

    private void persist(String key, DonationEvent event) throws SQLException {
        String json = GSON.toJson(event);
        if (json.getBytes(StandardCharsets.UTF_8).length > MAX_EVENT_JSON_BYTES) {
            throw new SQLException("donation payload is too large for inbox");
        }

        // Capture room binding at ingress: replay must not trigger turns in a
        // room that happened to become active after this donation arrived.
        List<String> roomIds = List.copyOf(matcher.matchingRooms(event));
        long now = System.currentTimeMillis();
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                boolean existing;
                try (var find = connection.prepareStatement(
                    "SELECT 1 FROM board_donation_inbox WHERE inbox_key = ?"
                )) {
                    find.setString(1, key);
                    try (var rows = find.executeQuery()) {
                        existing = rows.next();
                    }
                }
                if (!existing) {
                    try (var count = connection.prepareStatement(
                        "SELECT COUNT(*) FROM board_donation_inbox WHERE state = 'PENDING'"
                    ); var rows = count.executeQuery()) {
                        if (rows.next() && rows.getInt(1) >= MAX_PENDING) {
                            throw new SQLException("donation inbox pending capacity exceeded");
                        }
                    }
                    try (var insert = connection.prepareStatement("""
                        INSERT OR IGNORE INTO board_donation_inbox(
                          inbox_key, donation_json, room_ids_json, state, created_at_ms
                        ) VALUES (?, ?, ?, 'PENDING', ?)
                        """)) {
                        insert.setString(1, key);
                        insert.setString(2, json);
                        insert.setString(3, GSON.toJson(roomIds));
                        insert.setLong(4, now);
                        insert.executeUpdate();
                    }
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException("failed to persist donation event", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private Entry oldestPending() throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT inbox_key, donation_json, room_ids_json,
                        attempts, next_attempt_at_ms
                 FROM board_donation_inbox
                 WHERE state = 'PENDING'
                 ORDER BY created_at_ms, rowid
                 LIMIT 1
                 """);
             var rows = statement.executeQuery()) {
            if (!rows.next()) return null;
            DonationEvent donation = GSON.fromJson(
                rows.getString("donation_json"), DonationEvent.class
            );
            List<String> rooms = GSON.fromJson(
                rows.getString("room_ids_json"), ROOM_IDS_TYPE
            );
            if (donation == null || rooms == null) {
                throw new SQLException("corrupt persisted donation event");
            }
            return new Entry(
                rows.getString("inbox_key"), donation, List.copyOf(rooms),
                rows.getInt("attempts"), rows.getLong("next_attempt_at_ms")
            );
        }
    }

    private void markDone(String key) throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_donation_inbox
                 SET state = 'DONE', completed_at_ms = ?, last_error = NULL
                 WHERE inbox_key = ? AND state = 'PENDING'
                 """)) {
            statement.setLong(1, System.currentTimeMillis());
            statement.setString(2, key);
            if (statement.executeUpdate() != 1) {
                throw new SQLException("donation inbox acknowledgement changed");
            }
        }
    }

    private void markRetry(Entry entry, Exception error) throws SQLException {
        long delay = Math.min(60000L, 2000L << Math.min(5, entry.attempts()));
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_donation_inbox
                 SET attempts = attempts + 1, next_attempt_at_ms = ?,
                     last_error = ?
                 WHERE inbox_key = ? AND state = 'PENDING'
                 """)) {
            statement.setLong(1, System.currentTimeMillis() + delay);
            statement.setString(2, safeMessage(error));
            statement.setString(3, entry.key());
            statement.executeUpdate();
        }
    }

    private void pruneDoneOccasionally() throws SQLException {
        long now = System.currentTimeMillis();
        if (now - lastPruneMs < PRUNE_INTERVAL_MS) return;
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 DELETE FROM board_donation_inbox
                 WHERE state = 'DONE' AND completed_at_ms < ?
                 """)) {
            statement.setLong(1, now - DONE_RETENTION_MS);
            statement.executeUpdate();
        }
        lastPruneMs = now;
    }

    private static String inboxKey(DonationEvent donation) throws SQLException {
        String material = donation.provider() + "\u0000"
            + donation.channelId() + "\u0000"
            + BoardGameRuntimeEngine.fingerprint(donation);
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(material.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new SQLException("SHA-256 is not supported", error);
        }
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        if (message == null || message.isBlank()) {
            message = error.getClass().getSimpleName();
        }
        return message.length() > 500 ? message.substring(0, 500) : message;
    }

    private record Entry(
        String key, DonationEvent donation, List<String> roomIds,
        int attempts, long nextAttemptAtMs
    ) {}
}
