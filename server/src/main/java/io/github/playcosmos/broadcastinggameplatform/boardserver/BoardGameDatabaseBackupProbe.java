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
                    statement.execute("PRAGMA user_version=24");
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
                        rows.next() && rows.getInt(1) == 24,
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
                    rows.next() && rows.getInt(1) == 25,
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
