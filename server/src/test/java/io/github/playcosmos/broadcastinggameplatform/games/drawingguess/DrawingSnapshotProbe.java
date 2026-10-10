package io.github.playcosmos.broadcastinggameplatform.games.drawingguess;

import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public final class DrawingSnapshotProbe {
    private DrawingSnapshotProbe() {}

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory("drawing-snapshot-probe-");
        try {
            var db = new BoardGameDatabase(root.resolve("platform.db"));
            db.initialize();
            var sync = new DrawingSyncService(db);
            var game = new DrawingGuessGameService(
                new DrawingGuessRepository(db), sync
            );
            var room = game.createRoom(
                new DrawingGuessGameService.CreateRoomCommand(
                    "Snapshot Probe", DrawerPolicy.STREAMER_DRAWER,
                    "streamer", null, 600, false, null, null, List.of()
                )
            );
            game.markReady(room.roomId());
            var match = game.startMatch(room.roomId(), 1);
            var round = game.startRound(
                match.matchId(),
                new DrawingGuessGameService.StartRoundCommand(
                    "snapshot-prompt", "secret", List.of()
                ), Instant.now()
            );
            var session = round.drawingSession();
            var code = session.drawingCode();
            var token = session.drawerToken();

            sync.append(code, token, """
                {"type":"canvas.stroke.begin","payload":{"stroke":{
                  "strokeId":"persistent-stroke","tool":"pen","color":"#101010",
                  "width":8,"points":[{"x":0.1,"y":0.2}]
                }}}
                """);
            sync.append(code, token, """
                {"type":"canvas.stroke.points","payload":{
                  "strokeId":"persistent-stroke",
                  "points":[{"x":0.5,"y":0.6}]
                }}
                """);
            sync.append(code, token, """
                {"type":"canvas.undo","payload":{}}
                """);

            String padding = "x".repeat(7000);
            String noop = "{\"type\":\"canvas.stroke.end\","
                + "\"payload\":{\"strokeId\":\"persistent-stroke\","
                + "\"padding\":\"" + padding + "\"}}";
            for (int i = 0; i < 1300; i++) {
                sync.append(code, token, noop);
            }

            var compacted = sync.history(code);
            require(!compacted.isEmpty()
                    && JsonParser.parseString(compacted.get(0))
                        .getAsJsonObject().get("type").getAsString()
                        .equals("canvas.snapshot.begin"),
                "bounded event journal must begin replay with snapshot");
            require(compacted.size() < 1300,
                "large event history must be compacted");
            long bytes = compacted.stream().mapToLong(event ->
                event.getBytes(StandardCharsets.UTF_8).length).sum();
            require(bytes <= 8L * 1024 * 1024,
                "replay must fit history budget");
            require(rows(db, round.publicRound().roundId()) < 1300,
                "persistent raw events must be pruned at compaction");
            require(snapshotSequence(db, round.publicRound().roundId()) > 0,
                "durable snapshot sequence must advance");

            // Compacted snapshot must retain undone strokes for future REDO.
            var restoredUndo = replay(sync.history(code));
            require(restoredUndo.snapshot().getAsJsonArray("strokes").size() == 0,
                "compacted undo must hide the active stroke");
            require(restoredUndo.snapshot().getAsJsonArray("redoStack").size() == 1,
                "snapshot must preserve redo stack");
            sync.append(code, token, """
                {"type":"canvas.redo","payload":{}}
                """);
            var restoredRedo = replay(sync.history(code));
            require(restoredRedo.snapshot().getAsJsonArray("strokes").size() == 1,
                "redo after compaction must restore visible stroke");
            require(restoredRedo.snapshot().getAsJsonArray("strokes")
                .get(0).getAsJsonObject().getAsJsonArray("points").size() == 2,
                "stroke point history must survive compaction");

            var reboot = new DrawingSyncService(db);
            require(!reboot.isAuthorizedDrawer(code, token),
                "process restart must revoke old drawer token");
            var reloaded = replay(reboot.history(code));
            require(
                reloaded.snapshot().equals(restoredRedo.snapshot()),
                "restarted server must replay identical canvas and undo state"
            );
            System.out.println("[drawing-snapshot-probe] PASS");
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); }
                    catch (Exception ignored) {}
                });
            }
        }
    }

    private static DrawingCanvasDocument replay(List<String> messages) {
        DrawingCanvasDocument result = new DrawingCanvasDocument();
        StringBuilder chunks = null;
        int chunkCount = 0;
        for (String json : messages) {
            var event = JsonParser.parseString(json).getAsJsonObject();
            String type = event.get("type").getAsString();
            switch (type) {
                case "canvas.snapshot.begin" -> {
                    chunks = new StringBuilder();
                    chunkCount = 0;
                }
                case "canvas.snapshot.chunk" -> {
                    require(chunks != null && event.get("index").getAsInt() == chunkCount,
                        "snapshot chunks must be ordered");
                    chunks.append(event.get("data").getAsString());
                    chunkCount++;
                }
                case "canvas.snapshot.end" -> {
                    require(chunks != null, "snapshot end requires begin");
                    result = DrawingCanvasDocument.restore(
                        JsonParser.parseString(chunks.toString()).getAsJsonObject()
                    );
                    chunks = null;
                }
                default -> result.apply(event);
            }
        }
        require(chunks == null, "snapshot cannot end mid-transfer");
        return result;
    }

    private static int rows(BoardGameDatabase db, String roundId)
        throws Exception {
        try (var connection = db.open();
             var query = connection.prepareStatement(
                 "SELECT COUNT(*) FROM drawing_guess_canvas_event WHERE round_id = ?"
             )) {
            query.setString(1, roundId);
            try (var rows = query.executeQuery()) {
                rows.next();
                return rows.getInt(1);
            }
        }
    }

    private static long snapshotSequence(BoardGameDatabase db, String roundId)
        throws Exception {
        try (var connection = db.open();
             var query = connection.prepareStatement(
                 "SELECT snapshot_sequence FROM drawing_guess_canvas_session WHERE round_id = ?"
             )) {
            query.setString(1, roundId);
            try (var rows = query.executeQuery()) {
                require(rows.next(), "persistent canvas session must exist");
                return rows.getLong(1);
            }
        }
    }

    private static void require(boolean condition, String reason) {
        if (!condition) throw new IllegalStateException(reason);
    }
}
