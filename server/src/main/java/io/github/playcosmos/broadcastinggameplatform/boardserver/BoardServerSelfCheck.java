package io.github.playcosmos.broadcastinggameplatform.boardserver;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;

/**
 * Lightweight packaged-server self check.
 *
 * This class is production code because the Windows package verifier invokes
 * PlatformServerMain --board-server-probe after jpackage. Regression Probe
 * classes delegate here but are excluded from the shipped shaded jar.
 */
public final class BoardServerSelfCheck {
    private BoardServerSelfCheck() {}

    public static int run() {
        Path root = null;
        try {
            root = Files.createTempDirectory(
                "ramyani-board-server-self-check-"
            );
            var database = new BoardGameDatabase(
                root.resolve("board-game.db")
            );
            database.initialize();

            var tables = new HashSet<String>();
            try (var connection = database.open();
                 var statement = connection.prepareStatement(
                     "SELECT name FROM sqlite_master WHERE type='table'"
                 );
                 var rows = statement.executeQuery()) {
                while (rows.next()) {
                    tables.add(rows.getString(1));
                }
            }

            require(
                tables.contains("board_room"),
                "board_room table missing"
            );
            require(
                tables.contains("board_game_state"),
                "board_game_state table missing"
            );
            require(
                tables.contains("board_game_event"),
                "board_game_event table missing"
            );
            require(
                tables.contains("board_game_deferred_donation"),
                "deferred donation table missing"
            );
            require(
                !tables.contains("ticket"),
                "roulette ticket table must not exist"
            );
            require(
                !tables.contains("donor"),
                "roulette donor table must not exist"
            );
            require(
                !tables.contains("donation_event"),
                "roulette donation table must not exist"
            );

            System.out.println("[board-server-self-check] PASS");
            return 0;
        } catch (Exception error) {
            System.err.println(
                "[board-server-self-check] FAIL: "
                    + error.getMessage()
            );
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (root != null) {
                try (var paths = Files.walk(root)) {
                    paths.sorted((a, b) -> b.compareTo(a))
                        .forEach(path -> {
                            try {
                                Files.deleteIfExists(path);
                            } catch (Exception ignored) {
                            }
                        });
                } catch (Exception ignored) {
                }
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
