package io.github.playcosmos.broadcastinggameplatform.room;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.platform.events.DonationEvent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

public final class DonationInboxProbe {
    private DonationInboxProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("board-donation-inbox-probe-");
        try {
            var database = new BoardGameDatabase(root.resolve("probe.db"));
            database.initialize();
            var event = new DonationEvent(
                "SOOP", "channel-a", "viewer-1", "Viewer",
                100, "balloon", 1, "{\"event_id\":\"unique-1\"}", 123456L
            );

            var firstAttempts = new AtomicInteger();
            var failing = new DonationInboxService(
                database,
                ignored -> List.of("ROOM_A"),
                (donation, rooms) -> {
                    firstAttempts.incrementAndGet();
                    throw new SQLException("simulated processing outage");
                }
            );
            failing.accept(event);
            failing.accept(event);
            require(count(database, "PENDING") == 1,
                "duplicate donation must insert once");
            require(failing.drainBatch(16) == 0,
                "failed processing must not acknowledge donation");
            require(firstAttempts.get() == 1,
                "failed processing must attempt once");

            var recoveredCount = new AtomicInteger();
            var recovered = new DonationInboxService(
                database,
                ignored -> List.of("ROOM_B"),
                (donation, rooms) -> {
                    require(rooms.equals(List.of("ROOM_A")),
                        "replay must retain rooms originally bound at ingress");
                    recoveredCount.incrementAndGet();
                }
            );
            require(recovered.recoverAfterRestart() == 1,
                "startup must replay failed persisted donation");
            require(recoveredCount.get() == 1
                    && count(database, "PENDING") == 0
                    && count(database, "DONE") == 1,
                "replayed event must be marked DONE");
            recovered.accept(event);
            require(recovered.drainBatch(16) == 0
                    && recoveredCount.get() == 1,
                "repeat provider event id must not process twice");

            var offline = new AtomicBoolean(true);
            DatabaseAccess flaky = new DatabaseAccess() {
                @Override public Path path() { return database.path(); }

                @Override public Connection open() throws SQLException {
                    if (offline.get()) throw new SQLException("temporarily offline");
                    return database.open();
                }
            };
            var bufferedCount = new AtomicInteger();
            var buffered = new DonationInboxService(
                flaky,
                ignored -> List.of("ROOM_C"),
                (donation, rooms) -> bufferedCount.incrementAndGet()
            );
            buffered.accept(new DonationEvent(
                "SOOP", "channel-c", "viewer-2", "Viewer 2",
                100, "balloon", 2, "{\"event_id\":\"unique-2\"}", 123457L
            ));
            require(buffered.volatileBufferedCount() == 1,
                "temporary storage outage must queue bounded volatile fallback");
            offline.set(false);
            require(buffered.drainBatch(16) == 1
                    && buffered.volatileBufferedCount() == 0
                    && bufferedCount.get() == 1,
                "volatile fallback must persist and replay after storage returns");

            System.out.println("[donation-inbox-probe] PASS");
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); }
                    catch (Exception ignored) {}
                });
            }
        }
    }

    private static int count(BoardGameDatabase database, String state)
        throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement(
                 "SELECT COUNT(*) FROM board_donation_inbox WHERE state = ?"
             )) {
            statement.setString(1, state);
            try (var rows = statement.executeQuery()) {
                rows.next();
                return rows.getInt(1);
            }
        }
    }

    private static void require(boolean valid, String reason) {
        if (!valid) throw new IllegalStateException(reason);
    }
}
