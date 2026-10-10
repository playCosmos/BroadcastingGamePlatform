package io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * A real second SQLite writer commits between reading a Viewer Draw session
 * row and reading its members/result. The reader must see one WAL snapshot.
 */
public final class ViewerDrawReadSnapshotProbe {
    private ViewerDrawReadSnapshotProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("viewer-draw-read-snapshot-");
        try {
            var database = new BoardGameDatabase(root.resolve("draw.db"));
            database.initialize();
            var service = new ViewerDrawService(database);
            var draft = service.create(
                "Concurrent read", "RANDOM", List.of("Before"),
                Map.of("winnerCount", 1)
            );
            String sessionId = draft.sessionId();

            var afterSessionRead = new CountDownLatch(1);
            var afterConcurrentWrite = new CountDownLatch(1);
            DatabaseAccess gatedDatabase = new DatabaseAccess() {
                @Override public Path path() { return database.path(); }

                @Override public Connection open() throws SQLException {
                    Connection delegate = database.open();
                    return (Connection) Proxy.newProxyInstance(
                        Connection.class.getClassLoader(),
                        new Class<?>[] {Connection.class},
                        (proxy, method, arguments) -> {
                            if ("prepareStatement".equals(method.getName())
                                && arguments != null
                                && arguments.length > 0
                                && arguments[0] instanceof String sql
                                && sql.contains("FROM viewer_draw_entry\n")
                                && sql.contains("ORDER BY entry_index")) {
                                afterSessionRead.countDown();
                                if (!afterConcurrentWrite.await(
                                    15, TimeUnit.SECONDS
                                )) {
                                    throw new SQLException(
                                        "concurrent write did not finish"
                                    );
                                }
                            }
                            try {
                                return method.invoke(delegate, arguments);
                            } catch (InvocationTargetException error) {
                                throw error.getCause();
                            }
                        }
                    );
                }
            };

            var gatedReader = new ViewerDrawService(gatedDatabase);
            try (var executor = Executors.newSingleThreadExecutor()) {
                var reader = executor.submit(() -> gatedReader.find(sessionId));
                require(afterSessionRead.await(15, TimeUnit.SECONDS),
                    "reader never reached members lookup");
                try {
                    concurrentComplete(database, sessionId);
                } finally {
                    afterConcurrentWrite.countDown();
                }
                var before = reader.get(15, TimeUnit.SECONDS);
                require("DRAFT".equals(before.state())
                    && before.result() == null
                    && before.entries().size() == 1
                    && "Before".equals(before.entries().get(0).displayName()),
                    "single read must not mix old session with new entries/result");
            }

            var after = service.find(sessionId);
            require("COMPLETED".equals(after.state())
                && after.result() != null
                && "After".equals(after.entries().get(0).displayName()),
                "fresh read must see all committed concurrent changes");
            require(service.findByPublicCode(draft.publicCode()).equals(after),
                "public-code lookup must return the same committed snapshot");
            require(service.recent(10).stream().anyMatch(after::equals),
                "history listing must assemble consistent session snapshots");

            System.out.println("[viewer-draw-read-snapshot-probe] PASS");
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); }
                    catch (Exception ignored) {}
                });
            }
        }
    }

    private static void concurrentComplete(
        BoardGameDatabase database, String sessionId
    ) throws SQLException {
        String now = Instant.now().toString();
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    UPDATE viewer_draw_session
                    SET state = 'COMPLETED', completed_at = ?, updated_at = ?
                    WHERE session_id = ?
                    """)) {
                    statement.setString(1, now);
                    statement.setString(2, now);
                    statement.setString(3, sessionId);
                    require(statement.executeUpdate() == 1,
                        "session not updated");
                }
                try (var statement = connection.prepareStatement("""
                    UPDATE viewer_draw_entry SET display_name = 'After'
                    WHERE session_id = ?
                    """)) {
                    statement.setString(1, sessionId);
                    require(statement.executeUpdate() == 1,
                        "entry not updated");
                }
                try (var statement = connection.prepareStatement("""
                    INSERT INTO viewer_draw_result (
                        session_id, result_json, rng_algorithm,
                        audit_json, created_at
                    ) VALUES (?, ?, 'PROBE', '{}', ?)
                    """)) {
                    statement.setString(1, sessionId);
                    statement.setString(2, "{\"winner\":\"After\"}");
                    statement.setString(3, now);
                    statement.executeUpdate();
                }
                connection.commit();
            } catch (SQLException error) {
                connection.rollback();
                throw error;
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private static void require(boolean condition, String reason) {
        if (!condition) throw new IllegalStateException(reason);
    }
}
