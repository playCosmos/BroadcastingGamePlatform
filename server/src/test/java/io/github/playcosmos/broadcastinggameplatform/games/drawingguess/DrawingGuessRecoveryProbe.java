package io.github.playcosmos.broadcastinggameplatform.games.drawingguess;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import java.nio.file.Files;
import java.time.Instant;
import java.util.List;

public final class DrawingGuessRecoveryProbe {
    private DrawingGuessRecoveryProbe() {}

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory(
            "drawing-guess-recovery-probe-"
        );
        try {
            var database = new BoardGameDatabase(
                root.resolve("platform.db")
            );
            database.initialize();

            var repository1 = new DrawingGuessRepository(database);
            var sync1 = new DrawingSyncService(database);
            var service1 = new DrawingGuessGameService(
                repository1,
                sync1
            );

            var room = service1.createRoom(
                new DrawingGuessGameService.CreateRoomCommand(
                    "Recovery Probe",
                    DrawerPolicy.STREAMER_DRAWER,
                    "streamer",
                    null,
                    120,
                    false,
                    null,
                    null,
                    List.of()
                )
            );
            service1.markReady(room.roomId());
            var match = service1.startMatch(room.roomId(), 2);
            var firstRound = service1.startRound(
                match.matchId(),
                new DrawingGuessGameService.StartRoundCommand(
                    "recovery-prompt",
                    "복구정답",
                    List.of()
                ),
                Instant.now()
            );

            String drawingCode =
                firstRound.drawingSession().drawingCode();
            String oldToken =
                firstRound.drawingSession().drawerToken();

            sync1.append(
                drawingCode,
                oldToken,
                """
                {
                  "type":"canvas.stroke.begin",
                  "payload":{
                    "stroke":{
                      "strokeId":"recover-stroke",
                      "tool":"pen",
                      "color":"#111111",
                      "width":8,
                      "points":[{"x":0.1,"y":0.2}]
                    }
                  }
                }
                """
            );
            sync1.append(
                drawingCode,
                oldToken,
                """
                {
                  "type":"canvas.stroke.points",
                  "payload":{
                    "strokeId":"recover-stroke",
                    "points":[{"x":0.3,"y":0.4}]
                  }
                }
                """
            );
            sync1.append(
                drawingCode,
                oldToken,
                """
                {
                  "type":"canvas.stroke.end",
                  "payload":{"strokeId":"recover-stroke"}
                }
                """
            );

            require(
                sync1.history(drawingCode).size() == 3,
                "pre-restart history must contain three events"
            );

            // Simulate a fresh process against the same SQLite database.
            var repository2 = new DrawingGuessRepository(database);
            var sync2 = new DrawingSyncService(database);
            var service2 = new DrawingGuessGameService(
                repository2,
                sync2
            );

            var recovery = service2.recoverAfterRestart();
            require(
                recovery.activeRounds() == 1,
                "one active round must be reconciled"
            );
            require(
                recovery.restoredCanvasSessions() == 1,
                "persisted canvas session must be restored"
            );
            require(
                recovery.recreatedCanvasSessions() == 0,
                "restored round must not allocate a new canvas code"
            );

            var publicAfterRestart = service2.publicRoom(
                room.roomId()
            );
            require(
                drawingCode.equals(publicAfterRestart.drawingCode()),
                "OBS drawing code must remain stable after restart"
            );
            require(
                sync2.history(drawingCode).size() == 3,
                "stroke history must survive restart"
            );
            require(
                !sync2.isAuthorizedDrawer(drawingCode, oldToken),
                "pre-restart drawer token must be invalidated"
            );

            var recoveredDrawer = service2.recoverDrawerRound(
                firstRound.publicRound().roundId()
            );
            String newToken =
                recoveredDrawer.drawingSession().drawerToken();
            require(
                !oldToken.equals(newToken),
                "drawer recovery must issue a new token"
            );
            require(
                sync2.isAuthorizedDrawer(drawingCode, newToken),
                "reissued drawer token must authorize writes"
            );
            require(
                "복구정답".equals(
                    recoveredDrawer.privateRound().prompt().answer()
                ),
                "private prompt must be restored for the drawer"
            );
            require(
                recoveredDrawer.drawingSession().lastSequence() == 3,
                "drawer recovery must advertise persisted last sequence"
            );

            String resumed = sync2.append(
                drawingCode,
                newToken,
                """
                {
                  "type":"canvas.clear",
                  "payload":{}
                }
                """
            );
            require(
                resumed.contains("\"sequence\":4"),
                "sequence must continue after restart"
            );

            // A second restart must preserve the newly appended event and
            // invalidate the token from the previous process again.
            var sync3 = new DrawingSyncService(database);
            var service3 = new DrawingGuessGameService(
                new DrawingGuessRepository(database),
                sync3
            );
            var recovery2 = service3.recoverAfterRestart();
            require(
                recovery2.restoredCanvasSessions() == 1,
                "second restart must restore the canvas session"
            );
            require(
                sync3.history(drawingCode).size() == 4,
                "post-restart event must persist"
            );
            require(
                !sync3.isAuthorizedDrawer(drawingCode, newToken),
                "drawer token must rotate on every process restart"
            );

            service3.completeRound(
                firstRound.publicRound().roundId()
            );
            require(
                !sync3.isActive(drawingCode),
                "round completion must close recovered canvas session"
            );
            require(
                persistedCanvasRows(
                    database,
                    firstRound.publicRound().roundId()
                ) == 0,
                "closed canvas session and event history must be purged"
            );

            var syncAfterClose = new DrawingSyncService(database);
            require(
                syncAfterClose.persistentRoundSessionCount() == 0,
                "closed canvas session must not restore"
            );

            // Legacy/transition case: an ACTIVE round exists without a
            // V19 canvas-session row. Recovery must allocate one.
            var transitionRoom = service3.createRoom(
                new DrawingGuessGameService.CreateRoomCommand(
                    "Transition Probe",
                    DrawerPolicy.STREAMER_DRAWER,
                    "streamer",
                    null,
                    120,
                    false,
                    null,
                    null,
                    List.of()
                )
            );
            service3.markReady(transitionRoom.roomId());
            var transitionMatch = service3.startMatch(
                transitionRoom.roomId(),
                1
            );
            var transitionRound = new DrawingGuessRepository(database)
                .startRound(
                    transitionMatch.matchId(),
                    0,
                    "streamer",
                    new io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawingPrompt(
                        "transition-prompt",
                        "전환정답",
                        List.of()
                    ),
                    Instant.now(),
                    Instant.now().plusSeconds(120)
                );

            var transitionSync = new DrawingSyncService(database);
            var transitionService = new DrawingGuessGameService(
                new DrawingGuessRepository(database),
                transitionSync
            );
            var transitionRecovery =
                transitionService.recoverAfterRestart();
            require(
                transitionRecovery.recreatedCanvasSessions() == 1,
                "active legacy round without canvas row must be recreated"
            );
            require(
                transitionService.publicRoom(transitionRoom.roomId())
                    .drawingCode() != null,
                "recreated canvas must become public overlay binding"
            );

            // Expired active rounds are completed during restart recovery.
            var expiredRoom = transitionService.createRoom(
                new DrawingGuessGameService.CreateRoomCommand(
                    "Expired Probe",
                    DrawerPolicy.STREAMER_DRAWER,
                    "streamer",
                    null,
                    60,
                    false,
                    null,
                    null,
                    List.of()
                )
            );
            transitionService.markReady(expiredRoom.roomId());
            var expiredMatch = transitionService.startMatch(
                expiredRoom.roomId(),
                1
            );

            Instant expiredStart = Instant.now().minusSeconds(70);
            var expiredRound = new DrawingGuessRepository(database)
                .startRound(
                    expiredMatch.matchId(),
                    0,
                    "streamer",
                    new io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawingPrompt(
                        "expired-prompt",
                        "만료정답",
                        List.of()
                    ),
                    expiredStart,
                    expiredStart.plusSeconds(60)
                );

            var finalSync = new DrawingSyncService(database);
            var finalRepository = new DrawingGuessRepository(database);
            var finalService = new DrawingGuessGameService(
                finalRepository,
                finalSync
            );
            var finalRecovery = finalService.recoverAfterRestart();
            require(
                finalRecovery.expiredRounds() >= 1,
                "expired active round must be completed on recovery"
            );
            require(
                "COMPLETED".equals(
                    finalRepository.findRoundPrivate(
                        expiredRound.roundId()
                    ).state()
                ),
                "expired round state must persist as COMPLETED"
            );

            System.out.println(
                "Drawing Guess recovery probe passed."
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

    private static int persistedCanvasRows(
        BoardGameDatabase database,
        String roundId
    ) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT
                   (SELECT COUNT(*)
                    FROM drawing_guess_canvas_session
                    WHERE round_id = ?)
                   +
                   (SELECT COUNT(*)
                    FROM drawing_guess_canvas_event
                    WHERE round_id = ?)
                 """)) {
            statement.setString(1, roundId);
            statement.setString(2, roundId);
            try (var rows = statement.executeQuery()) {
                return rows.next() ? rows.getInt(1) : -1;
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
