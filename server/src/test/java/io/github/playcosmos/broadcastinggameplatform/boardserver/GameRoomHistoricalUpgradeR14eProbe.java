package io.github.playcosmos.broadcastinggameplatform.boardserver;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.util.List;

/**
 * R14e release rehearsal: build the real V28 schema from the historical
 * migrations, then upgrade a copy through all V29..V44 migrations.
 * Only disposable temporary SQLite files are ever opened.
 */
public final class GameRoomHistoricalUpgradeR14eProbe {
    private GameRoomHistoricalUpgradeR14eProbe() {}
    private static int checks;
    private static final int LEGACY_VERSION = 25; // V4..V28 (25 migrations)
    private static final int CURRENT_VERSION = 41; // V4..V44 (41 migrations)

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("game-room-r14e-upgrade-");
        try {
            Path source = root.resolve("legacy-v28.sqlite");
            createLegacyV28(source);
            check(version(source) == LEGACY_VERSION, "real V28 fixture version");
            Path migrated = root.resolve("upgraded.sqlite");
            Files.copy(source, migrated, StandardCopyOption.COPY_ATTRIBUTES);
            var database = new BoardGameDatabase(migrated);
            database.initialize();
            verifyCurrent(migrated, "first upgrade");

            Path backups = root.resolve("backups");
            List<Path> saved;
            try (var items = Files.list(backups)) {
                saved = items.filter(Files::isRegularFile).toList();
            }
            check(saved.size() == 1, "one pre-upgrade backup produced");
            Path backup = saved.get(0);
            check(backup.getFileName().toString().contains(".schema-v25-"),
                "backup labeled with the true pre-upgrade version");
            check(version(backup) == LEGACY_VERSION,
                "pre-upgrade backup has untouched schema version");
            verifyLegacyRow(backup, "backup preserved legacy application row");
            check(!hasTable(backup, "game_room"),
                "pre-upgrade backup has no R1 GameRoom tables");

            database.initialize();
            long retained;
            try (var files = Files.list(backups)) {
                retained = files.count();
            }
            check(retained == 1, "current startup is migration-idempotent");

            // Restore the auto-created backup to a distinct, disposable path
            // and rehearse exactly the same V28-to-current migration again.
            Path restored = root.resolve("restored.sqlite");
            Files.copy(backup, restored, StandardCopyOption.REPLACE_EXISTING);
            check(version(restored) == LEGACY_VERSION, "restore retains V28");
            var replay = new BoardGameDatabase(restored);
            replay.initialize();
            verifyCurrent(restored, "restored backup re-upgrade");
            check(version(source) == LEGACY_VERSION,
                "original legacy fixture remains unchanged");
            System.out.println("GAME_ROOM_R14E_HISTORICAL_UPGRADE_PASSED checks="
                + checks + " from=V28 to=V44 restore=true");
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted((left, right) -> right.compareTo(left))
                    .forEach(path -> {
                        try { Files.deleteIfExists(path); }
                        catch (Exception ignored) {}
                    });
            }
        }
    }

    private static void createLegacyV28(Path target) throws Exception {
        Path directory = Path.of("src/main/resources/db/migration");
        try (var connection = DriverManager.getConnection("jdbc:sqlite:"
                    + target.toAbsolutePath());
             var statement = connection.createStatement()) {
            statement.execute("PRAGMA foreign_keys=ON");
            for (int migration = 4; migration <= 28; migration++) {
                String filename = "V" + migration + "__";
                List<Path> files;
                try (var stream = Files.list(directory)) {
                    files = stream.filter(path -> path.getFileName().toString()
                        .startsWith(filename))
                        .filter(path -> path.toString().endsWith(".sql")).toList();
                }
                check(files.size() == 1, "one historical SQL migration " + filename);
                String sql = Files.readString(files.get(0), StandardCharsets.UTF_8);
                connection.setAutoCommit(false);
                try {
                    for (String entry : sql.split(";")) {
                        String trimmed = entry.trim();
                        if (!trimmed.isEmpty()) statement.execute(trimmed);
                    }
                    statement.execute("PRAGMA user_version=" + (migration - 3));
                    connection.commit();
                } catch (Exception failure) {
                    connection.rollback();
                    throw failure;
                } finally {
                    connection.setAutoCommit(true);
                }
            }
            // This is a real legacy Board row, not just a synthetic marker
            // table that an upgrade would trivially leave untouched.
            statement.execute("""
                INSERT INTO board_room
                    (room_id,name,status,config_json,preview_json,preview_seed,
                     created_at,updated_at)
                VALUES ('r14e-legacy-room','R14e legacy board','DRAFT','{}',
                        '{}',123,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')
                """);
        }
        verifyLegacyRow(target, "source V28 legacy Board row");
    }

    private static void verifyLegacyRow(Path path, String name) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:"
                + path.toAbsolutePath());
             var statement = connection.createStatement();
             var rows = statement.executeQuery(
                "SELECT name,preview_seed FROM board_room"
                + " WHERE room_id='r14e-legacy-room'")) {
            check(rows.next() && "R14e legacy board".equals(rows.getString(1))
                && rows.getInt(2) == 123, name);
        }
    }

    private static void verifyCurrent(Path path, String stage) throws Exception {
        check(version(path) == CURRENT_VERSION, stage + " full V44 schema");
        verifyLegacyRow(path, stage + " legacy Board data preserved");
        check(hasTable(path, "game_room"), stage + " shared GameRoom migrated");
        check(hasTable(path, "game_room_telephone_match"),
            stage + " telephone migrated");
        try (var connection = DriverManager.getConnection("jdbc:sqlite:"
                    + path.toAbsolutePath());
             var statement = connection.createStatement()) {
            try (ResultSet rows = statement.executeQuery("PRAGMA integrity_check")) {
                check(rows.next() && "ok".equals(rows.getString(1)),
                    stage + " SQLite integrity");
            }
            try (ResultSet rows = statement.executeQuery("PRAGMA foreign_key_check")) {
                check(!rows.next(), stage + " SQLite foreign keys");
            }
        }
    }

    private static boolean hasTable(Path path, String table) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:"
                    + path.toAbsolutePath());
             var statement = connection.prepareStatement(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?")) {
            statement.setString(1, table);
            try (var rows = statement.executeQuery()) {
                return rows.next() && rows.getInt(1) == 1;
            }
        }
    }

    private static int version(Path path) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:"
                    + path.toAbsolutePath());
             var statement = connection.createStatement();
             var rows = statement.executeQuery("PRAGMA user_version")) {
            return rows.next() ? rows.getInt(1) : -1;
        }
    }

    private static void check(boolean valid, String description) {
        if (!valid) throw new AssertionError("R14e upgrade: " + description);
        checks++;
    }
}
