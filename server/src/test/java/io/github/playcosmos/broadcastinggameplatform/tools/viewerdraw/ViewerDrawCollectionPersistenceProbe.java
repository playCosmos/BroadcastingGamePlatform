package io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChatMessageEvent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

public final class ViewerDrawCollectionPersistenceProbe {
    private ViewerDrawCollectionPersistenceProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("viewer-draw-collection-");
        try {
            var db = new BoardGameDatabase(root.resolve("collection.db"));
            db.initialize();
            var original = new ViewerDrawService(db);
            original.openChatEntryCollection("SOOP", "test-channel", "!join");
            for (int index = 0; index < 150; index++) {
                require(original.processChatMessage(
                    chat("viewer-" + index, "!join")),
                    "valid participant not accepted: " + index
                );
            }
            require(!original.processChatMessage(
                chat("viewer-1", "!join")),
                "duplicate identity must be rejected"
            );
            original.pauseEntryCollection();

            var restarted = new ViewerDrawService(db);
            var paused = restarted.entryCollectionSnapshot();
            require("PAUSED".equals(paused.state())
                && "SOOP".equals(paused.provider())
                && "test-channel".equals(paused.channelId())
                && "!join".equals(paused.keyword())
                && paused.entryCount() == 150
                && paused.acceptedMessages() == 150
                && paused.duplicateMessages() == 1,
                "collection configuration, counts, or entrants lost on restart");
            require(paused.entries().get(0).userId().equals("viewer-0")
                && paused.entries().get(149).userId().equals("viewer-149"),
                "stable participant insertion order must survive restart");
            require(!restarted.processChatMessage(chat("viewer-200", "!join")),
                "paused collection must reject new participants");
            restarted.resumeEntryCollection();
            require(!restarted.processChatMessage(chat("viewer-1", "!join")),
                "identity deduplication must work after restart");
            require(restarted.processChatMessage(chat("viewer-200", "!join")),
                "resumed collection must accept new participants");
            restarted.closeEntryCollection();

            var third = new ViewerDrawService(db);
            var closed = third.entryCollectionSnapshot();
            require("CLOSED".equals(closed.state())
                && closed.entryCount() == 151
                && closed.duplicateMessages() == 2,
                "closed collection and counters must survive second restart");

            third.clearEntryCollection();
            var fourth = new ViewerDrawService(db);
            var cleared = fourth.entryCollectionSnapshot();
            require(cleared.entryCount() == 0 && cleared.acceptedMessages() == 0
                && cleared.duplicateMessages() == 0,
                "clear must be durable");
            fourth.openChatEntryCollection("SOOP", "another", "!next");
            require(new ViewerDrawService(db).entryCollectionSnapshot()
                .entryCount() == 0, "new collection must not inherit old members");

            // The SQL insert must complete before the Java collection mutates.
            fourth.processChatMessage(new ChatMessageEvent(
                "SOOP", "another", "after-reset", "After Reset",
                "!next", "", System.currentTimeMillis()
            ));
            try (var connection = db.open();
                 var statement = connection.createStatement()) {
                statement.execute("DROP TABLE viewer_draw_entry_collection_member");
            }
            boolean blocked = false;
            try {
                fourth.processChatMessage(new ChatMessageEvent(
                    "SOOP", "another", "db-failure", "DB Failure",
                    "!next", "", System.currentTimeMillis()
                ));
            } catch (IllegalStateException expected) {
                blocked = true;
            }
            require(blocked && fourth.entryCollectionSnapshot().entryCount() == 1,
                "failed persistence must not acknowledge an in-memory member");

            System.out.println("[viewer-draw-collection-probe] PASS");
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); }
                    catch (Exception ignored) {}
                });
            }
        }
    }

    private static ChatMessageEvent chat(String userId, String message) {
        return new ChatMessageEvent(
            "SOOP", "test-channel", userId, userId,
            message, "", System.currentTimeMillis()
        );
    }

    private static void require(boolean valid, String reason) {
        if (!valid) throw new IllegalStateException(reason);
    }
}
