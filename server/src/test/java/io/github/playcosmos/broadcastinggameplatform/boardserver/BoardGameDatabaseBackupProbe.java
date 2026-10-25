package io.github.playcosmos.broadcastinggameplatform.boardserver;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;

public final class BoardGameDatabaseBackupProbe {
    private BoardGameDatabaseBackupProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory(
            "bgp-database-backup-probe-"
        );
        try {
            Path databasePath = root.resolve("platform.db");
            var database = new BoardGameDatabase(databasePath);
            database.initialize();
            int currentSchemaVersion;
            try (var connection = database.open();
                 var statement = connection.createStatement();
                 var rows = statement.executeQuery(
                     "PRAGMA user_version"
                 )) {
                require(
                    rows.next(),
                    "current schema version must be readable"
                );
                currentSchemaVersion = rows.getInt(1);
            }
            require(
                currentSchemaVersion > 1,
                "backup probe requires at least two migrations"
            );
            int previousSchemaVersion = currentSchemaVersion - 1;

            try (var connection = database.open();
                 var statement = connection.createStatement()) {
                statement.execute("""
                    CREATE TABLE IF NOT EXISTS backup_probe(
                      marker TEXT NOT NULL
                    )
                    """);
                statement.execute(
                    "DELETE FROM backup_probe"
                );
                statement.execute(
                    "INSERT INTO backup_probe(marker) VALUES ('kept')"
                );
            }

            for (int cycle = 0; cycle < 6; cycle += 1) {
                try (var connection = database.open();
                     var statement = connection.createStatement()) {
                    // A previous-version test fixture must have the previous
                    // SCHEMA, not merely a decremented PRAGMA. V31 introduced
                    // these tables; dropping them reproduces a real V30 DB.
                    if (currentSchemaVersion == 40
                        && previousSchemaVersion == 39) {
                        // R13d V43 presenter state is added after V42.
                        statement.execute(
                            "ALTER TABLE game_room_telephone_match DROP COLUMN reveal_revision");
                        statement.execute(
                            "ALTER TABLE game_room_telephone_match DROP COLUMN reveal_step");
                        statement.execute(
                            "ALTER TABLE game_room_telephone_match DROP COLUMN reveal_album");
                    } else if (currentSchemaVersion == 39
                        && previousSchemaVersion == 38) {
                        // V42 only introduces a defaulted cooperative mode.
                        statement.execute(
                            "ALTER TABLE game_room_telephone_match DROP COLUMN mode");
                    } else if (currentSchemaVersion == 38
                        && previousSchemaVersion == 37) {
                        // Telephone mode V41 owns three independent match tables.
                        statement.execute("DROP TABLE game_room_telephone_entry");
                        statement.execute("DROP TABLE game_room_telephone_player");
                        statement.execute("DROP TABLE game_room_telephone_match");
                    } else if (currentSchemaVersion == 37
                        && previousSchemaVersion == 36) {
                        // R13a V40 freezes the drawer roster and adds optional
                        // metadata without changing the old game-room policy.
                        statement.execute(
                            "DROP TABLE game_room_drawing_drawer_roster");
                        statement.execute(
                            "ALTER TABLE game_room_drawing_link DROP COLUMN streamer_rotation");
                        statement.execute(
                            "ALTER TABLE game_room_drawing_broadcast_binding DROP COLUMN drawer_member_id");
                    } else if (currentSchemaVersion == 36
                        && previousSchemaVersion == 35) {
                        // Recreate the exact pre-V39 schema (SQLite DROP COLUMN
                        // cannot remove an indexed or constrained column).
                        statement.execute(
                            "DROP TABLE game_room_drawing_broadcast_grant");
                        statement.execute(
                            "DROP INDEX idx_game_room_drawing_broadcast_room");
                        statement.execute(
                            "ALTER TABLE game_room_drawing_broadcast_binding DROP COLUMN authorized_at");
                        statement.execute(
                            "CREATE INDEX idx_game_room_drawing_broadcast_room "
                            + "ON game_room_drawing_broadcast_binding(room_id)");
                    } else if (currentSchemaVersion == 35
                        && previousSchemaVersion == 34) {
                        // V38 adds optional incoming broadcast channel leases.
                        statement.execute(
                            "DROP TABLE game_room_drawing_broadcast_binding");
                    } else if (currentSchemaVersion == 34
                        && previousSchemaVersion == 33) {
                        // Recover real V36 schema before replaying V37.
                        statement.execute("DROP INDEX idx_game_room_public_idle");
                        statement.execute(
                            "ALTER TABLE game_room_public DROP COLUMN last_active_at");
                    } else if (currentSchemaVersion == 33
                        && previousSchemaVersion == 32) {
                        // V36 only adds the opt-in room visibility table.
                        statement.execute("DROP TABLE game_room_public");
                    } else if (currentSchemaVersion == 32
                        && previousSchemaVersion == 31) {
                        // V35 removes the common drawing binding and source key.
                        statement.execute("DROP TABLE game_room_drawing_link");
                        statement.execute("DROP INDEX ux_drawing_guess_source_room");
                        statement.execute("ALTER TABLE drawing_guess_room DROP COLUMN source_room_id");
                    } else {
                        throw new IllegalStateException(
                            "refresh pre-migration schema fixture for latest migration");
                    }
                    statement.execute(
                        "PRAGMA user_version=" + previousSchemaVersion
                    );
                }
                database.initialize();
            }

            Path backupDirectory = root.resolve("backups");
            require(
                Files.isDirectory(backupDirectory),
                "migration backup directory must be created"
            );
            java.util.List<Path> backups;
            try (var files = Files.list(backupDirectory)) {
                backups = files
                    .filter(Files::isRegularFile)
                    .sorted()
                    .toList();
            }
            require(
                backups.size() == 5,
                "only the latest five migration backups must remain"
            );

            Path backup = backups.get(backups.size() - 1);
            try (var connection = DriverManager.getConnection(
                     "jdbc:sqlite:" + backup.toAbsolutePath()
                 );
                 var statement = connection.createStatement()) {
                try (var rows = statement.executeQuery(
                    "PRAGMA user_version"
                )) {
                    require(
                        rows.next()
                            && rows.getInt(1) == previousSchemaVersion,
                        "pre-migration backup must preserve old schema version"
                    );
                }
                try (var rows = statement.executeQuery(
                    "SELECT marker FROM backup_probe"
                )) {
                    require(
                        rows.next() && "kept".equals(rows.getString(1)),
                        "pre-migration backup must preserve application data"
                    );
                }
            }

            try (var connection = database.open();
                 var statement = connection.createStatement();
                 var rows = statement.executeQuery(
                     "PRAGMA user_version"
                 )) {
                require(
                    rows.next()
                        && rows.getInt(1) == currentSchemaVersion,
                    "live database must finish at current schema version"
                );
            }

            long before;
            try (var files = Files.list(backupDirectory)) {
                before = files.filter(Files::isRegularFile).count();
            }
            database.initialize();
            long after;
            try (var files = Files.list(backupDirectory)) {
                after = files.filter(Files::isRegularFile).count();
            }
            require(
                before == after,
                "current schema startup must not create redundant backup"
            );

            System.out.println(
                "Board database backup probe passed."
            );
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted((left, right) -> right.compareTo(left))
                    .forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (Exception ignored) {
                        }
                    });
            }
        }
    }

    private static void require(
        boolean condition,
        String message
    ) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
