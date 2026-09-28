package io.github.playcosmos.broadcastinggameplatform.games.drawingguess;

import com.google.gson.Gson;
import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.ClassicScorePolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawingPrompt;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.ScoreProfile;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import java.nio.file.Files;
import java.time.Instant;
import java.util.List;

public final class DrawingGuessPersistenceProbe {
    private static final Gson GSON = new Gson();

    private DrawingGuessPersistenceProbe() {}

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory(
            "drawing-guess-persistence-probe-"
        );
        try {
            var database = new BoardGameDatabase(
                root.resolve("platform.db")
            );
            database.initialize();

            var repository = new DrawingGuessRepository(database);
            var scoreConfig = new ClassicScorePolicy.Config(
                ScoreProfile.FAST_GUESS,
                500,
                100,
                25,
                50
            );

            var room = repository.createRoom(
                "Persistence Probe",
                DrawerPolicy.ROTATING_DRAWER,
                null,
                scoreConfig,
                60,
                List.of(
                    new DrawingGuessRepository.ParticipantInput(
                        "p1", "SOOP", "user-1", "P1"
                    ),
                    new DrawingGuessRepository.ParticipantInput(
                        "p2", "SOOP", "user-2", "P2"
                    ),
                    new DrawingGuessRepository.ParticipantInput(
                        "p3", null, null, "P3"
                    )
                )
            );

            require(
                room.roomId().matches("[A-HJ-NP-Z2-9]{6}"),
                "drawing room code must be six characters"
            );
            require(
                room.participants().size() == 3,
                "three participants expected"
            );
            require(
                room.scoreProfile() == ScoreProfile.FAST_GUESS,
                "score profile must persist"
            );

            room = repository.markReady(room.roomId());
            require(
                "READY".equals(room.state()),
                "room must become READY"
            );

            var match = repository.createMatch(room.roomId(), 3);
            require(
                "ACTIVE".equals(match.state()),
                "match must start ACTIVE"
            );

            Instant started = Instant.parse(
                "2026-09-28T12:00:00Z"
            );
            var round = repository.startRound(
                match.matchId(),
                0,
                "p1",
                new DrawingPrompt(
                    "prompt-1",
                    "프라이팬",
                    List.of("후라이팬")
                ),
                started,
                started.plusSeconds(60)
            );

            String publicBefore = GSON.toJson(
                repository.findRoundPublic(round.roundId())
            );
            require(
                !publicBefore.contains("프라이팬")
                    && !publicBefore.contains("후라이팬")
                    && !publicBefore.contains("acceptedAnswers")
                    && !publicBefore.contains("answer"),
                "public persisted round must not expose answers"
            );

            repository.recordCorrectGuess(
                round.roundId(),
                "p2",
                "P2",
                1,
                420,
                50,
                started.plusSeconds(10)
            );

            var publicRound = repository.findRoundPublic(
                round.roundId()
            );
            require(
                publicRound.correctGuesses().size() == 1,
                "correct guess must persist"
            );
            require(
                publicRound.drawerScore() == 50,
                "drawer round score must persist"
            );

            var updatedRoom = repository.findRoom(room.roomId());
            int p1Score = updatedRoom.participants().stream()
                .filter(p -> "p1".equals(p.participantId()))
                .findFirst()
                .orElseThrow()
                .score();
            int p2Score = updatedRoom.participants().stream()
                .filter(p -> "p2".equals(p.participantId()))
                .findFirst()
                .orElseThrow()
                .score();

            require(p1Score == 50, "drawer score must accumulate");
            require(p2Score == 420, "guesser score must accumulate");

            round = repository.completeRound(round.roundId());
            require(
                "COMPLETED".equals(round.state()),
                "round must complete"
            );

            match = repository.completeMatch(match.matchId());
            require(
                "COMPLETED".equals(match.state()),
                "match must complete"
            );
            require(
                "COMPLETED".equals(
                    repository.findRoom(room.roomId()).state()
                ),
                "room must complete with match"
            );

            var streamerRoom = repository.createRoom(
                "Streamer Probe",
                DrawerPolicy.STREAMER_DRAWER,
                "streamer",
                scoreConfig,
                60,
                List.of(
                    new DrawingGuessRepository.ParticipantInput(
                        "viewer-1", "SOOP", "viewer-1", "Viewer 1"
                    )
                )
            );
            streamerRoom = repository.markReady(
                streamerRoom.roomId()
            );
            var streamerMatch = repository.createMatch(
                streamerRoom.roomId(),
                1
            );
            var streamerRound = repository.startRound(
                streamerMatch.matchId(),
                0,
                "streamer",
                new DrawingPrompt(
                    "prompt-2",
                    "사과",
                    List.of()
                ),
                started,
                started.plusSeconds(60)
            );
            repository.recordCorrectGuess(
                streamerRound.roundId(),
                "viewer-1",
                "Viewer 1",
                1,
                500,
                50,
                started.plusSeconds(5)
            );
            require(
                repository.findRoom(streamerRoom.roomId())
                    .participants()
                    .get(0)
                    .score() == 500,
                "non-competing streamer drawer must not break score write"
            );

            System.out.println(
                "Drawing Guess persistence probe passed."
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
