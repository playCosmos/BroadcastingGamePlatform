package io.github.playcosmos.broadcastinggameplatform.games.drawingguess;

import com.google.gson.Gson;
import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.ClassicScorePolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.ScoreProfile;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChatMessageEvent;
import java.nio.file.Files;
import java.time.Instant;
import java.util.List;

public final class DrawingGuessChatProbe {
    private static final Gson GSON = new Gson();

    private DrawingGuessChatProbe() {}

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory(
            "drawing-guess-chat-probe-"
        );
        try {
            var database = new BoardGameDatabase(
                root.resolve("platform.db")
            );
            database.initialize();

            var repository = new DrawingGuessRepository(database);
            var drawingSync = new DrawingSyncService();
            var service = new DrawingGuessGameService(
                repository,
                drawingSync
            );

            var scoreConfig = new ClassicScorePolicy.Config(
                ScoreProfile.FAST_GUESS,
                500,
                100,
                25,
                50
            );

            var streamerRoom = service.createRoom(
                new DrawingGuessGameService.CreateRoomCommand(
                    "Streamer Chat",
                    DrawerPolicy.STREAMER_DRAWER,
                    "streamer",
                    scoreConfig,
                    60,
                    true,
                    "SOOP",
                    "channel-a",
                    List.of()
                )
            );
            require(
                streamerRoom.participants().isEmpty(),
                "streamer mode must allow zero preset participants"
            );

            service.markReady(streamerRoom.roomId());
            var streamerMatch = service.startMatch(
                streamerRoom.roomId(),
                1
            );
            Instant started = Instant.now();
            var roundStart = service.startRound(
                streamerMatch.matchId(),
                new DrawingGuessGameService.StartRoundCommand(
                    "prompt-chat-1",
                    "사과",
                    List.of("apple")
                ),
                started
            );

            var wrong = service.processChatMessage(
                chat(
                    "SOOP",
                    "channel-a",
                    "viewer-1",
                    "Viewer 1",
                    "배",
                    started.plusSeconds(5)
                )
            );
            require(
                "WRONG".equals(wrong.status()),
                "wrong chat must not score"
            );
            require(
                repository.findRoom(streamerRoom.roomId())
                    .participants()
                    .isEmpty(),
                "wrong chat must not register dynamic participant"
            );

            var correct = service.processChatMessage(
                chat(
                    "SOOP",
                    "channel-a",
                    "viewer-1",
                    "Viewer 1",
                    "사과",
                    started.plusSeconds(6)
                )
            );
            require(
                "CORRECT".equals(correct.status())
                    && correct.rank() == 1
                    && correct.guesserScore() > 0,
                "first correct chat must score"
            );

            var afterFirst = repository.findRoom(
                streamerRoom.roomId()
            );
            require(
                afterFirst.participants().size() == 1,
                "correct viewer must be dynamically registered"
            );
            var firstParticipant = afterFirst.participants().get(0);
            require(
                !firstParticipant.canDraw(),
                "dynamic chat entrant must never join drawer rotation"
            );
            int scoreAfterFirst = firstParticipant.score();

            var duplicate = service.processChatMessage(
                chat(
                    "SOOP",
                    "channel-a",
                    "viewer-1",
                    "Viewer 1",
                    "apple",
                    started.plusSeconds(7)
                )
            );
            require(
                "DUPLICATE_CORRECT".equals(duplicate.status())
                    && duplicate.rank() == 1,
                "duplicate correct chat must be identified"
            );
            require(
                repository.findRoom(streamerRoom.roomId())
                    .participants()
                    .get(0)
                    .score() == scoreAfterFirst,
                "duplicate correct chat must not add score"
            );

            var wrongChannel = service.processChatMessage(
                chat(
                    "SOOP",
                    "channel-b",
                    "viewer-2",
                    "Viewer 2",
                    "사과",
                    started.plusSeconds(8)
                )
            );
            require(
                "NO_ACTIVE_ROOM".equals(wrongChannel.status()),
                "non-bound channel must be ignored"
            );

            var second = service.processChatMessage(
                chat(
                    "SOOP",
                    "channel-a",
                    "viewer-2",
                    "Viewer 2",
                    "사 과!!",
                    started.plusSeconds(9)
                )
            );
            require(
                "CORRECT".equals(second.status())
                    && second.rank() == 2,
                "second correct viewer rank mismatch"
            );

            String publicJson = GSON.toJson(
                service.publicRoom(streamerRoom.roomId())
            );
            require(
                !publicJson.contains("사과")
                    && !publicJson.contains("apple")
                    && !publicJson.contains("viewer-1")
                    && !publicJson.contains("viewer-2"),
                "public room must hide answer aliases and provider user IDs"
            );

            service.completeRound(
                roundStart.publicRound().roundId()
            );
            service.completeMatch(streamerMatch.matchId());

            var rotatingRoom = service.createRoom(
                new DrawingGuessGameService.CreateRoomCommand(
                    "Rotating Chat",
                    DrawerPolicy.ROTATING_DRAWER,
                    null,
                    scoreConfig,
                    60,
                    true,
                    "SOOP",
                    "channel-r",
                    List.of(
                        new DrawingGuessRepository.ParticipantInput(
                            "p1",
                            "SOOP",
                            "drawer-user-1",
                            "Drawer 1"
                        ),
                        new DrawingGuessRepository.ParticipantInput(
                            "p2",
                            "SOOP",
                            "drawer-user-2",
                            "Drawer 2"
                        )
                    )
                )
            );
            service.markReady(rotatingRoom.roomId());
            var rotatingMatch = service.startMatch(
                rotatingRoom.roomId(),
                2
            );
            var rotatingRound = service.startRound(
                rotatingMatch.matchId(),
                new DrawingGuessGameService.StartRoundCommand(
                    "prompt-chat-2",
                    "고양이",
                    List.of()
                ),
                started
            );
            require(
                "p1".equals(
                    rotatingRound.publicRound().drawerParticipantId()
                ),
                "first rotating drawer must be p1"
            );

            var drawerGuess = service.processChatMessage(
                chat(
                    "SOOP",
                    "channel-r",
                    "drawer-user-1",
                    "Drawer 1",
                    "고양이",
                    started.plusSeconds(4)
                )
            );
            require(
                "DRAWER_IGNORED".equals(drawerGuess.status()),
                "current rotating drawer must not guess"
            );

            var audienceCorrect = service.processChatMessage(
                chat(
                    "SOOP",
                    "channel-r",
                    "audience-1",
                    "Audience",
                    "고양이",
                    started.plusSeconds(5)
                )
            );
            require(
                "CORRECT".equals(audienceCorrect.status()),
                "external chat viewer must be allowed to guess"
            );

            service.completeRound(
                rotatingRound.publicRound().roundId()
            );

            var secondRound = service.startRound(
                rotatingMatch.matchId(),
                new DrawingGuessGameService.StartRoundCommand(
                    "prompt-chat-3",
                    "강아지",
                    List.of()
                ),
                started.plusSeconds(70)
            );
            require(
                "p2".equals(
                    secondRound.publicRound().drawerParticipantId()
                ),
                "dynamic chat entrant must not alter rotating drawer order"
            );

            System.out.println("Drawing Guess chat probe passed.");
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

    private static ChatMessageEvent chat(
        String provider,
        String channelId,
        String userId,
        String nickname,
        String message,
        Instant occurredAt
    ) {
        return new ChatMessageEvent(
            provider,
            channelId,
            userId,
            nickname,
            message,
            "{}",
            occurredAt.toEpochMilli()
        );
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
