package io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application;

import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawingPrompt;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChatMessageEvent;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class DrawingGuessGameService {
    private final DrawingGuessRepository repository;
    private final DrawingSyncService drawingSync;
    private final Map<String, String> drawingCodeByRound =
        new ConcurrentHashMap<>();

    public DrawingGuessGameService(
        DrawingGuessRepository repository,
        DrawingSyncService drawingSync
    ) {
        this.repository = repository;
        this.drawingSync = drawingSync;
    }

    public record CreateRoomCommand(
        String name,
        DrawerPolicy drawerPolicy,
        String streamerParticipantId,
        ClassicScorePolicy.Config scoreConfig,
        int roundDurationSeconds,
        boolean chatGuessEnabled,
        String chatProvider,
        String chatChannelId,
        List<DrawingGuessRepository.ParticipantInput> participants
    ) {
        public CreateRoomCommand(
            String name,
            DrawerPolicy drawerPolicy,
            String streamerParticipantId,
            ClassicScorePolicy.Config scoreConfig,
            int roundDurationSeconds,
            List<DrawingGuessRepository.ParticipantInput> participants
        ) {
            this(
                name,
                drawerPolicy,
                streamerParticipantId,
                scoreConfig,
                roundDurationSeconds,
                true,
                null,
                null,
                participants
            );
        }
    }

    public record StartRoundCommand(
        String promptId,
        String answer,
        List<String> acceptedAnswers
    ) {}

    public record RoundStart(
        DrawingGuessRepository.RoundPublic publicRound,
        DrawingGuessRepository.RoundPrivate privateRound,
        DrawingSyncService.Session drawingSession
    ) {}

    public record ChatGuessResult(
        String status,
        String roomId,
        String roundId,
        String participantId,
        String displayName,
        int rank,
        int guesserScore,
        int drawerScore
    ) {
        public boolean correct() {
            return "CORRECT".equals(status)
                || "DUPLICATE_CORRECT".equals(status);
        }
    }

    public record PublicParticipant(
        String participantId,
        String displayName,
        int score
    ) {}

    public record CompletedRoundReveal(
        String roundId,
        int roundIndex,
        String answer,
        String completedAt,
        List<DrawingGuessRepository.CorrectGuessRecord> correctGuesses
    ) {}

    public record PublicRoomSnapshot(
        String roomId,
        String name,
        DrawerPolicy drawerPolicy,
        String state,
        int roundDurationSeconds,
        List<PublicParticipant> participants,
        DrawingGuessRepository.Match activeMatch,
        DrawingGuessRepository.RoundPublic activeRound,
        String drawingCode,
        CompletedRoundReveal lastCompletedRound
    ) {}

    public DrawingGuessRepository.Room createRoom(
        CreateRoomCommand command
    ) throws SQLException {
        if (command == null) {
            throw new IllegalArgumentException("room command is required");
        }
        return repository.createRoom(
            command.name(),
            command.drawerPolicy(),
            command.streamerParticipantId(),
            command.scoreConfig(),
            command.roundDurationSeconds(),
            command.chatGuessEnabled(),
            command.chatProvider(),
            command.chatChannelId(),
            command.participants()
        );
    }

    public DrawingGuessRepository.Room markReady(String roomId)
        throws SQLException {
        return repository.markReady(roomId);
    }

    public DrawingGuessRepository.Match startMatch(
        String roomId,
        int totalRounds
    ) throws SQLException {
        if (repository.findActiveMatchByRoom(roomId) != null) {
            throw new IllegalStateException(
                "room already has an active match"
            );
        }
        return repository.createMatch(roomId, totalRounds);
    }

    public RoundStart startRound(
        String matchId,
        StartRoundCommand command,
        Instant now
    ) throws SQLException {
        if (command == null) {
            throw new IllegalArgumentException(
                "round command is required"
            );
        }

        var match = repository.findMatch(matchId);
        if (!"ACTIVE".equals(match.state())) {
            throw new IllegalStateException("match must be ACTIVE");
        }
        if (repository.findActiveRoundByMatch(matchId) != null) {
            throw new IllegalStateException(
                "complete the active round first"
            );
        }

        var room = repository.findRoom(match.roomId());
        int roundIndex = repository.nextRoundIndex(matchId);
        if (roundIndex >= match.totalRounds()) {
            throw new IllegalStateException(
                "all configured rounds are already completed"
            );
        }
        String drawer = drawerForRound(room, roundIndex);

        Instant startedAt = now == null ? Instant.now() : now;
        Instant expiresAt = startedAt.plusSeconds(
            room.roundDurationSeconds()
        );

        var prompt = new DrawingPrompt(
            command.promptId(),
            command.answer(),
            command.acceptedAnswers()
        );

        var privateRound = repository.startRound(
            matchId,
            roundIndex,
            drawer,
            prompt,
            startedAt,
            expiresAt
        );
        var drawingSession = drawingSync.createSession();
        drawingCodeByRound.put(
            privateRound.roundId(),
            drawingSession.drawingCode()
        );

        return new RoundStart(
            repository.findRoundPublic(privateRound.roundId()),
            privateRound,
            drawingSession
        );
    }

    public DrawingGuessRepository.RoundPrivate completeRound(
        String roundId
    ) throws SQLException {
        var completed = repository.completeRound(roundId);
        String drawingCode = drawingCodeByRound.remove(roundId);
        if (drawingCode != null) {
            drawingSync.closeSession(drawingCode);
        }
        return completed;
    }

    public DrawingGuessRepository.Match completeMatch(
        String matchId
    ) throws SQLException {
        var activeRound = repository.findActiveRoundByMatch(matchId);
        if (activeRound != null) {
            throw new IllegalStateException(
                "complete the active round before the match"
            );
        }
        return repository.completeMatch(matchId);
    }

    public synchronized ChatGuessResult processChatMessage(
        ChatMessageEvent event
    ) throws SQLException {
        if (
            event == null
            || event.provider() == null
            || event.provider().isBlank()
            || event.userId() == null
            || event.userId().isBlank()
            || event.message() == null
            || event.message().isBlank()
        ) {
            return new ChatGuessResult(
                "IGNORED",
                null,
                null,
                null,
                null,
                0,
                0,
                0
            );
        }

        List<DrawingGuessRepository.Room> rooms =
            repository.findRoomsForChatEvent(
                event.provider(),
                event.channelId()
            );

        if (rooms.isEmpty()) {
            return new ChatGuessResult(
                "NO_ACTIVE_ROOM",
                null,
                null,
                null,
                null,
                0,
                0,
                0
            );
        }

        if (rooms.size() > 1) {
            return new ChatGuessResult(
                "AMBIGUOUS_ROOM_BINDING",
                null,
                null,
                null,
                null,
                0,
                0,
                0
            );
        }

        var room = rooms.get(0);
        var match = repository.findActiveMatchByRoom(
            room.roomId()
        );
        if (match == null) {
            return new ChatGuessResult(
                "NO_ACTIVE_MATCH",
                room.roomId(),
                null,
                null,
                event.nickname(),
                0,
                0,
                0
            );
        }

        var round = repository.findActiveRoundByMatch(
            match.matchId()
        );
        if (round == null) {
            return new ChatGuessResult(
                "NO_ACTIVE_ROUND",
                room.roomId(),
                null,
                null,
                event.nickname(),
                0,
                0,
                0
            );
        }

        Instant guessedAt = event.occurredAtEpochMs() > 0
            ? Instant.ofEpochMilli(event.occurredAtEpochMs())
            : Instant.now();
        Instant expiresAt = Instant.parse(round.expiresAt());
        if (!guessedAt.isBefore(expiresAt)) {
            return new ChatGuessResult(
                "ROUND_EXPIRED",
                room.roomId(),
                round.roundId(),
                null,
                event.nickname(),
                0,
                0,
                0
            );
        }

        var existing = repository.findParticipantByProviderUser(
            room.roomId(),
            event.provider(),
            event.userId()
        );
        if (
            existing != null
            && round.drawerParticipantId().equals(
                existing.participantId()
            )
        ) {
            return new ChatGuessResult(
                "DRAWER_IGNORED",
                room.roomId(),
                round.roundId(),
                existing.participantId(),
                existing.displayName(),
                0,
                0,
                0
            );
        }

        var judge = new GuessJudge();
        if (!judge.isCorrect(round.prompt(), event.message())) {
            return new ChatGuessResult(
                "WRONG",
                room.roomId(),
                round.roundId(),
                existing == null ? null : existing.participantId(),
                event.nickname(),
                0,
                0,
                0
            );
        }

        var participant = existing != null
            ? existing
            : repository.ensureChatParticipant(
                room.roomId(),
                event.provider(),
                event.userId(),
                event.nickname()
            );

        var publicRound = repository.findRoundPublic(
            round.roundId()
        );
        for (var correct : publicRound.correctGuesses()) {
            if (
                correct.participantId().equals(
                    participant.participantId()
                )
            ) {
                return new ChatGuessResult(
                    "DUPLICATE_CORRECT",
                    room.roomId(),
                    round.roundId(),
                    participant.participantId(),
                    participant.displayName(),
                    correct.rank(),
                    correct.scoreAwarded(),
                    0
                );
            }
        }

        int rank = publicRound.correctGuesses().size() + 1;
        Instant startedAt = Instant.parse(round.startedAt());
        var award = new ClassicScorePolicy(
            room.scoreConfig()
        ).score(
            new DrawingScorePolicy.ScoreContext(
                Duration.between(startedAt, expiresAt),
                Duration.between(startedAt, guessedAt),
                rank,
                Math.max(0, room.participants().size() - 1)
            )
        );

        repository.recordCorrectGuess(
            round.roundId(),
            participant.participantId(),
            participant.displayName(),
            rank,
            award.guesserPoints(),
            award.drawerPoints(),
            guessedAt
        );

        return new ChatGuessResult(
            "CORRECT",
            room.roomId(),
            round.roundId(),
            participant.participantId(),
            participant.displayName(),
            rank,
            award.guesserPoints(),
            award.drawerPoints()
        );
    }

    public PublicRoomSnapshot publicRoom(String roomId)
        throws SQLException {
        var room = repository.findRoom(roomId);
        var match = repository.findActiveMatchByRoom(roomId);
        DrawingGuessRepository.RoundPublic round = null;
        String drawingCode = null;
        CompletedRoundReveal lastCompletedRound = null;
        if (match != null) {
            var privateRound = repository.findActiveRoundByMatch(
                match.matchId()
            );
            if (privateRound != null) {
                round = repository.findRoundPublic(
                    privateRound.roundId()
                );
                drawingCode = drawingCodeByRound.get(
                    privateRound.roundId()
                );
            } else {
                var completed = repository
                    .findLatestCompletedRoundByMatch(
                        match.matchId()
                    );
                if (completed != null) {
                    var completedPublic = repository.findRoundPublic(
                        completed.roundId()
                    );
                    lastCompletedRound =
                        new CompletedRoundReveal(
                            completed.roundId(),
                            completed.roundIndex(),
                            completed.prompt().answer(),
                            completed.completedAt(),
                            completedPublic.correctGuesses()
                        );
                }
            }
        }

        List<PublicParticipant> publicParticipants =
            room.participants().stream()
                .map(participant -> new PublicParticipant(
                    participant.participantId(),
                    participant.displayName(),
                    participant.score()
                ))
                .toList();

        return new PublicRoomSnapshot(
            room.roomId(),
            room.name(),
            room.drawerPolicy(),
            room.state(),
            room.roundDurationSeconds(),
            publicParticipants,
            match,
            round,
            drawingCode,
            lastCompletedRound
        );
    }

    private String drawerForRound(
        DrawingGuessRepository.Room room,
        int roundIndex
    ) {
        if (room.drawerPolicy() == DrawerPolicy.STREAMER_DRAWER) {
            return room.streamerParticipantId();
        }

        List<String> order = room.participants().stream()
            .filter(DrawingGuessRepository.Participant::canDraw)
            .map(DrawingGuessRepository.Participant::participantId)
            .toList();
        return new DrawerSelector(
            DrawerPolicy.ROTATING_DRAWER,
            null,
            order
        ).drawerForRound(roundIndex);
    }
}
