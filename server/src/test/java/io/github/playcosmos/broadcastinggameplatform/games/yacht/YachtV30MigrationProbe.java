package io.github.playcosmos.broadcastinggameplatform.games.yacht;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtMatchState;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;

/**
 * Reproduce a real pre-Y2 V29 DB and ensure V30 rebuild preserves state.
 * This deliberately starts from a manual V29 fixture, not from latest DB.
 */
public final class YachtV30MigrationProbe {
    private YachtV30MigrationProbe() {}

    public static void main(String[] args) throws Exception {
        Path temp = Files.createTempDirectory("yacht-v29-upgrade-");
        try {
            Path file = temp.resolve("platform.sqlite");
            String saved = """
                {"schema":1,"id":"legacy-yacht","name":"Old Match",
                 "phase":"READY","currentPlayer":0,"completedTurns":0,
                 "rolls":0,"dice":[0,0,0,0,0],
                 "held":[false,false,false,false,false],"version":0,
                 "players":[
                   {"id":"a","displayName":"A","scores":{},"repeatYachtCount":0},
                   {"id":"b","displayName":"B","scores":{},"repeatYachtCount":0}
                 ]}
                """;
            try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file);
                 var stmt = connection.createStatement()) {
                stmt.execute("""
                    CREATE TABLE yacht_match (
                      match_id TEXT PRIMARY KEY NOT NULL,
                      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
                      phase TEXT NOT NULL CHECK (phase IN ('READY','ACTIVE','PAUSED','FINISHED')),
                      state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 65536),
                      updated_at TEXT NOT NULL
                    )
                    """);
                stmt.execute("CREATE INDEX idx_yacht_match_phase ON yacht_match(phase)");
                try (var insert = connection.prepareStatement("""
                    INSERT INTO yacht_match(match_id,version,phase,state_json,updated_at)
                    VALUES('legacy-yacht',0,'READY',?,'2026-10-20T00:00:00Z')
                    """)) {
                    insert.setString(1, saved);
                    insert.executeUpdate();
                }
                // BoardGameDatabase maps resource V29 to migration index 26.
                stmt.execute("PRAGMA user_version=26");
            }

            var upgradedDb = new BoardGameDatabase(file);
            upgradedDb.initialize();
            var restored = new YachtRepository(upgradedDb).find("legacy-yacht");
            if (restored.phase() != YachtMatchState.Phase.READY
                || restored.players().size() != 2 || restored.version() != 0
                || !restored.dice().equals(YachtMatchState.emptyDice())) {
                throw new AssertionError("existing V29 state lost or changed during V30 upgrade");
            }
            try (var connection = upgradedDb.open();
                 var query = connection.createStatement()) {
                try (var schema = query.executeQuery("PRAGMA user_version")) {
                    if (!schema.next() || schema.getInt(1) != 27)
                        throw new AssertionError("V30 migration not applied");
                }
                query.executeUpdate("""
                    UPDATE yacht_match SET phase='CLOSED'
                    WHERE match_id='legacy-yacht'
                    """);
            }
            if (new YachtRepository(upgradedDb).find("legacy-yacht").phase()
                != YachtMatchState.Phase.READY) {
                // Deliberately invalid low-level tampering cannot be read as
                // a forged closed state with JSON still declaring READY.
                throw new AssertionError("unexpected state");
            }
        } catch (IllegalStateException expectedMismatch) {
            // The raw UPDATE above intentionally creates a DB/JSON mismatch.
            // It must fail closed rather than silently rewrite the snapshot.
            if (!expectedMismatch.getMessage().contains("snapshot"))
                throw expectedMismatch;
            System.out.println("YACHT_V30_MIGRATION_PASSED"
                + " legacy=preserved closed_constraint=enabled corruption=fail-closed");
            return;
        } finally {
            try (var walk = Files.walk(temp)) {
                walk.sorted((a,b)->b.compareTo(a)).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) {}
                });
            }
        }
        throw new AssertionError("migration integrity tamper should fail closed");
    }
}
