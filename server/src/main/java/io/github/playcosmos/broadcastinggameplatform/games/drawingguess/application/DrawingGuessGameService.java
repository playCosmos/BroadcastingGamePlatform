package io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application;

import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawingPrompt;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

public final class DrawingGuessGameService {
    private final DrawingGuessRepository repository;
    private final DrawingSyncService drawingSync;

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
        List<DrawingGuessRepository.ParticipantInput> participants
    ) {}

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

    public record PublicRoomSnapshot(
        String roomId,
        String name,
        DrawerPolicy drawerPolicy,
        String state,
        int roundDurationSeconds,
        List<DrawingGuessRepository.Participant> participants,
        DrawingGuessRepository.Match activeMatch,
        DrawingGuessRepository.RoundPublic activeRound
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

        return new RoundStart(
            repository.findRoundPublic(privateRound.roundId()),
            privateRound,
            drawingSession
        );
    }

    public DrawingGuessRepository.RoundPrivate completeRound(
        String roundId
    ) throws SQLException {
        return repository.completeRound(roundId);
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

    public PublicRoomSnapshot publicRoom(String roomId)
        throws SQLException {
        var room = repository.findRoom(roomId);
        var match = repository.findActiveMatchByRoom(roomId);
        DrawingGuessRepository.RoundPublic round = null;
        if (match != null) {
            var privateRound = repository.findActiveRoundByMatch(
                match.matchId()
            );
            if (privateRound != null) {
                round = repository.findRoundPublic(
                    privateRound.roundId()
                );
            }
        }

        return new PublicRoomSnapshot(
            room.roomId(),
            room.name(),
            room.drawerPolicy(),
            room.state(),
            room.roundDurationSeconds(),
            room.participants(),
            match,
            round
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
            .map(DrawingGuessRepository.Participant::participantId)
            .toList();
        return new DrawerSelector(
            DrawerPolicy.ROTATING_DRAWER,
            null,
            order
        ).drawerForRound(roundIndex);
    }
}
