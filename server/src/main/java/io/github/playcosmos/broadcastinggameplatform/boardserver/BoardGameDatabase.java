package io.github.playcosmos.broadcastinggameplatform.boardserver;

import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.util.Comparator;
import java.sql.DriverManager;
import java.sql.SQLException;

public final class BoardGameDatabase implements DatabaseAccess {
    private static final int MAX_MIGRATION_BACKUPS = 5;
    private static final String[] MIGRATIONS = {
        "/db/migration/V4__board_rooms.sql",
        "/db/migration/V5__board_room_live_status.sql",
        "/db/migration/V6__board_game_runtime.sql",
        "/db/migration/V7__single_active_board_room.sql",
        "/db/migration/V8__room_lifecycle_pause_and_effects.sql",
        "/db/migration/V9__pause_broadcast_grace.sql",
        "/db/migration/V10__multi_active_room_policy.sql",
        "/db/migration/V11__persistent_admin_auth.sql",
        "/db/migration/V12__admin_access_approval.sql",
        "/db/migration/V13__provider_identity.sql",
        "/db/migration/V14__provider_scoped_player_identity.sql",
        "/db/migration/V15__viewer_draw_core.sql",
        "/db/migration/V16__drawing_guess_rooms.sql",
        "/db/migration/V17__drawing_guess_dynamic_chat_participants.sql",
        "/db/migration/V18__drawing_guess_chat_binding.sql",
        "/db/migration/V19__drawing_guess_canvas_recovery.sql",
        "/db/migration/V20__viewer_draw_machine_maps.sql",
        "/db/migration/V21__viewer_draw_machine_map_revisions.sql",
        "/db/migration/V22__viewer_draw_marble_audit.sql",
        "/db/migration/V23__prune_closed_drawing_canvas_history.sql",
        "/db/migration/V24__remove_persisted_admin_bootstrap_token.sql",
        "/db/migration/V25__prune_viewer_draw_history.sql",
        "/db/migration/V26__prune_viewer_draw_sessions.sql",
        "/db/migration/V27__reset_admin_approval_codes.sql",
        "/db/migration/V28__prune_terminated_board_rooms.sql"
    };

    private final Path databasePath;
    private final String jdbcUrl;

    public BoardGameDatabase(Path databasePath) throws IOException {
        this.databasePath = databasePath.toAbsolutePath().normalize();
        if (this.databasePath.getParent() != null) Files.createDirectories(this.databasePath.getParent());
        this.jdbcUrl = "jdbc:sqlite:" + this.databasePath;
    }

    @Override
    public Path path() {
        return databasePath;
    }

    public void initialize() throws SQLException, IOException {
        try (var connection = open()) {
            try (var statement = connection.createStatement()) {
                statement.execute("PRAGMA journal_mode=WAL");
                statement.execute("PRAGMA foreign_keys=ON");
                statement.execute("PRAGMA busy_timeout=5000");
            }
            migrate(connection);
        }
    }

    @Override
    public Connection open() throws SQLException {
        var connection = DriverManager.getConnection(jdbcUrl);
        try (var statement = connection.createStatement()) {
            statement.execute("PRAGMA foreign_keys=ON");
            statement.execute("PRAGMA busy_timeout=5000");
        }
        return connection;
    }

    private void migrate(Connection connection) throws SQLException, IOException {
        int version;
        try (var statement = connection.createStatement();
             var rows = statement.executeQuery("PRAGMA user_version")) {
            version = rows.next() ? rows.getInt(1) : 0;
        }

        if (version > MIGRATIONS.length) {
            throw new SQLException(
                "board database schema is newer than this application: "
                    + version
            );
        }

        if (version > 0 && version < MIGRATIONS.length) {
            createPreMigrationBackup(connection, version);
        }

        while (version < MIGRATIONS.length) {
            int nextVersion = version + 1;
            connection.setAutoCommit(false);
            try {
                applyMigration(connection, MIGRATIONS[version]);
                try (var statement = connection.createStatement()) {
                    statement.execute("PRAGMA user_version=" + nextVersion);
                }
                connection.commit();
                version = nextVersion;
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                if (error instanceof IOException ioError) throw ioError;
                throw new SQLException("board migration failed", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private void createPreMigrationBackup(
        Connection connection,
        int schemaVersion
    ) throws IOException, SQLException {
        Path parent = databasePath.getParent();
        if (parent == null) return;

        Path backupDirectory = parent.resolve("backups");
        Files.createDirectories(backupDirectory);
        String baseName = databasePath.getFileName().toString()
            + ".schema-v" + schemaVersion + "-"
            + System.currentTimeMillis();

        Path backupPath = null;
        for (int attempt = 0; attempt < 100; attempt += 1) {
            Path candidate = backupDirectory.resolve(
                baseName
                    + (attempt == 0 ? "" : "-" + attempt)
                    + ".bak"
            );
            if (!Files.exists(candidate)) {
                backupPath = candidate;
                break;
            }
        }
        if (backupPath == null) {
            throw new IOException(
                "failed to allocate database migration backup path"
            );
        }

        String sqlPath = backupPath
            .toAbsolutePath()
            .normalize()
            .toString()
            .replace("'", "''");
        try (var statement = connection.createStatement()) {
            statement.execute("VACUUM INTO '" + sqlPath + "'");
        }
        pruneMigrationBackups(backupDirectory);
    }

    private void pruneMigrationBackups(Path backupDirectory) {
        String prefix = databasePath.getFileName().toString()
            + ".schema-v";
        try (var files = Files.list(backupDirectory)) {
            var backups = files
                .filter(Files::isRegularFile)
                .filter(path -> {
                    String name = path.getFileName().toString();
                    return name.startsWith(prefix)
                        && name.endsWith(".bak");
                })
                .sorted(
                    Comparator.comparingLong(
                        BoardGameDatabase::lastModifiedMillis
                    ).reversed()
                )
                .toList();
            for (
                int index = MAX_MIGRATION_BACKUPS;
                index < backups.size();
                index += 1
            ) {
                try {
                    Files.deleteIfExists(backups.get(index));
                } catch (IOException ignored) {
                }
            }
        } catch (IOException ignored) {
        }
    }

    private static long lastModifiedMillis(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException ignored) {
            return Long.MIN_VALUE;
        }
    }

    private static void applyMigration(
        Connection connection,
        String resource
    ) throws IOException, SQLException {
        try (var stream = BoardGameDatabase.class.getResourceAsStream(resource)) {
            if (stream == null) {
                throw new IOException(
                    "missing board migration resource: " + resource
                );
            }
            var sql = new String(
                stream.readAllBytes(),
                StandardCharsets.UTF_8
            );
            for (var statementSql : sql.split(";")) {
                var trimmed = statementSql.trim();
                if (trimmed.isEmpty()) continue;
                try (var statement = connection.createStatement()) {
                    statement.execute(trimmed);
                }
            }
        }
    }
}
