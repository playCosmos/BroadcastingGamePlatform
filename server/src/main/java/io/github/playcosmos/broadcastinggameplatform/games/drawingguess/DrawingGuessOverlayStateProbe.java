package io.github.playcosmos.broadcastinggameplatform.games.drawingguess;

import com.google.gson.Gson;
import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import java.nio.file.Files;
import java.time.Instant;
import java.util.List;

public final class DrawingGuessOverlayStateProbe {
    private static final Gson GSON = new Gson();

    private DrawingGuessOverlayStateProbe() {}

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory(
            "drawing-guess-overlay-probe-"
        );
        try {
            var database = new BoardGameDatabase(
                root.resolve("platform.db")
            );
            database.initialize();

            var sync = new DrawingSyncService();
            var service = new DrawingGuessGameService(
                new DrawingGuessRepository(database),
                sync
            );

            var room = service.createRoom(
                new DrawingGuessGameService.CreateRoomCommand(
                    "Overlay Probe",
                    DrawerPolicy.STREAMER_DRAWER,
                    "streamer",
                    null,
                    60,
                    true,
                    "SOOP",
                    "overlay-channel",
                    List.of()
                )
            );
            service.markReady(room.roomId());
            var match = service.startMatch(room.roomId(), 2);

            Instant start = Instant.parse(
                "2026-09-28T14:00:00Z"
            );
            var first = service.startRound(
                match.matchId(),
                new DrawingGuessGameService.StartRoundCommand(
                    "overlay-prompt-1",
                    "비밀정답",
                    List.of("비 밀 정 답")
                ),
                start
            );

            var active = service.publicRoom(room.roomId());
            String activeJson = GSON.toJson(active);
            require(
                active.activeRound() != null,
                "active public round required"
            );
            require(
                first.drawingSession().drawingCode().equals(
                    active.drawingCode()
                ),
                "public room must expose current drawing code"
            );
            require(
                active.lastCompletedRound() == null,
                "active round must not expose completed reveal"
            );
            require(
                !activeJson.contains("비밀정답")
                    && !activeJson.contains("비 밀 정 답")
                    && !activeJson.contains("drawerToken"),
                "active overlay state must hide answer and drawer token"
            );

            service.completeRound(
                first.publicRound().roundId()
            );

            var revealed = service.publicRoom(room.roomId());
            String revealedJson = GSON.toJson(revealed);
            require(
                revealed.activeRound() == null
                    && revealed.drawingCode() == null,
                "completed round must stop active canvas binding"
            );
            require(
                revealed.lastCompletedRound() != null
                    && "비밀정답".equals(
                        revealed.lastCompletedRound().answer()
                    ),
                "completed round must reveal canonical answer"
            );
            require(
                revealedJson.contains("비밀정답")
                    && !revealedJson.contains("drawerToken"),
                "reveal state must expose only safe completed answer"
            );

            var second = service.startRound(
                match.matchId(),
                new DrawingGuessGameService.StartRoundCommand(
                    "overlay-prompt-2",
                    "새정답",
                    List.of()
                ),
                start.plusSeconds(70)
            );

            var nextActive = service.publicRoom(room.roomId());
            String nextJson = GSON.toJson(nextActive);
            require(
                nextActive.activeRound() != null
                    && nextActive.lastCompletedRound() == null,
                "new active round must clear old reveal state"
            );
            require(
                second.drawingSession().drawingCode().equals(
                    nextActive.drawingCode()
                ),
                "new round must expose new drawing code"
            );
            require(
                !nextJson.contains("비밀정답")
                    && !nextJson.contains("새정답"),
                "active next round must not leak old or current answer"
            );

            System.out.println(
                "Drawing Guess overlay state probe passed."
            );
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted((a, b) -> b.compareTo(a))
                    .forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (Exception ignored) {}
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
