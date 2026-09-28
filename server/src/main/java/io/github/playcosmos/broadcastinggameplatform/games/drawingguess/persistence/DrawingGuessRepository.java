package io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.ClassicScorePolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawingPrompt;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.ScoreProfile;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;

public final class DrawingGuessRepository {
    private static final Gson GSON = new Gson();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String CODE_ALPHABET =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final int MAX_PARTICIPANTS = 20;

    private final DatabaseAccess database;

    public DrawingGuessRepository(DatabaseAccess database) {
        this.database = database;
    }

    public record ParticipantInput(
        String participantId,
        String provider,
        String userId,
        String displayName
    ) {}

    public record Participant(
        int order,
        String participantId,
        String provider,
        String userId,
        String displayName,
        int score
    ) {}

    public record Room(
        String roomId,
        String name,
        DrawerPolicy drawerPolicy,
        String streamerParticipantId,
        ScoreProfile scoreProfile,
        ClassicScorePolicy.Config scoreConfig,
        int roundDurationSeconds,
        String state,
        String createdAt,
        String updatedAt,
        List<Participant> participants
    ) {}

    public record Match(
        String matchId,
        String roomId,
        String state,
        int currentRoundIndex,
        int totalRounds,
        String startedAt,
        String completedAt
    ) {}

    public record RoundPrivate(
        String roundId,
        String matchId,
        int roundIndex,
        String drawerParticipantId,
        DrawingPrompt prompt,
        String state,
        String startedAt,
        String expiresAt,
        String completedAt,
        int drawerScore
    ) {}

    public record RoundPublic(
        String roundId,
        String matchId,
        int roundIndex,
        String drawerParticipantId,
        String state,
        String startedAt,
        String expiresAt,
        String completedAt,
        int drawerScore,
        List<CorrectGuessRecord> correctGuesses
    ) {}

    public record CorrectGuessRecord(
        String participantId,
        String displayName,
        int rank,
        int scoreAwarded,
        int drawerScoreAwarded,
        String guessedAt
    ) {}

    public Room createRoom(
        String name,
        DrawerPolicy drawerPolicy,
        String streamerParticipantId,
        ClassicScorePolicy.Config scoreConfig,
        int roundDurationSeconds,
        List<ParticipantInput> participantInputs
    ) throws SQLException {
        DrawerPolicy policy = drawerPolicy == null
            ? DrawerPolicy.ROTATING_DRAWER
            : drawerPolicy;
        ClassicScorePolicy.Config config = scoreConfig == null
            ? ClassicScorePolicy.Config.defaults()
            : scoreConfig;
        List<ParticipantInput> participants =
            normalizeParticipants(participantInputs);

        if (participants.isEmpty()) {
            throw new IllegalArgumentException(
                "at least one participant is required"
            );
        }
        if (roundDurationSeconds < 10 || roundDurationSeconds > 600) {
            throw new IllegalArgumentException(
                "roundDurationSeconds must be 10..600"
            );
        }

        String streamerId = streamerParticipantId == null
            ? null
            : streamerParticipantId.trim();
        if (
            policy == DrawerPolicy.STREAMER_DRAWER
            && (streamerId == null || streamerId.isBlank())
        ) {
            throw new IllegalArgumentException(
                "streamerParticipantId is required for STREAMER_DRAWER"
            );
        }

        if (
            policy == DrawerPolicy.ROTATING_DRAWER
            && participants.size() < 2
        ) {
            throw new IllegalArgumentException(
                "ROTATING_DRAWER requires at least two participants"
            );
        }

        String roomId = allocateRoomCode();
        String now = Instant.now().toString();
        String roomName = name == null || name.isBlank()
            ? "Drawing Guess"
            : name.trim();

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO drawing_guess_room(
                      room_id, name, drawer_policy,
                      streamer_participant_id, score_profile,
                      score_config_json, round_duration_seconds,
                      state, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
                    """)) {
                    statement.setString(1, roomId);
                    statement.setString(2, roomName);
                    statement.setString(3, policy.name());
                    statement.setString(4, streamerId);
                    statement.setString(5, config.profile().name());
                    statement.setString(6, GSON.toJson(config));
                    statement.setInt(7, roundDurationSeconds);
                    statement.setString(8, now);
                    statement.setString(9, now);
                    statement.executeUpdate();
                }

                int order = 0;
                for (ParticipantInput participant : participants) {
                    try (var statement = connection.prepareStatement("""
                        INSERT INTO drawing_guess_participant(
                          room_id, participant_order, participant_id,
                          provider_id, user_id, display_name, score
                        ) VALUES (?, ?, ?, ?, ?, ?, 0)
                        """)) {
                        statement.setString(1, roomId);
                        statement.setInt(2, order++);
                        statement.setString(3, participant.participantId());
                        statement.setString(4, participant.provider());
                        statement.setString(5, participant.userId());
                        statement.setString(6, participant.displayName());
                        statement.executeUpdate();
                    }
                }

                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException(
                    "failed to create drawing guess room",
                    error
                );
            } finally {
                connection.setAutoCommit(true);
            }
        }
        return findRoom(roomId);
    }

    public Room markReady(String roomId) throws SQLException {
        updateRoomState(roomId, "DRAFT", "READY");
        return findRoom(roomId);
    }

    public Match createMatch(
        String roomId,
        int totalRounds
    ) throws SQLException {
        Room room = findRoom(roomId);
        if (!"READY".equals(room.state())) {
            throw new IllegalStateException(
                "room must be READY before match start"
            );
        }
        if (totalRounds < 1 || totalRounds > 200) {
            throw new IllegalArgumentException(
                "totalRounds must be 1..200"
            );
        }

        String matchId = UUID.randomUUID().toString();
        String now = Instant.now().toString();

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO drawing_guess_match(
                      match_id, room_id, state, current_round_index,
                      total_rounds, started_at
                    ) VALUES (?, ?, 'ACTIVE', 0, ?, ?)
                    """)) {
                    statement.setString(1, matchId);
                    statement.setString(2, roomId);
                    statement.setInt(3, totalRounds);
                    statement.setString(4, now);
                    statement.executeUpdate();
                }
                try (var statement = connection.prepareStatement("""
                    UPDATE drawing_guess_room
                    SET state = 'ACTIVE', updated_at = ?
                    WHERE room_id = ? AND state = 'READY'
                    """)) {
                    statement.setString(1, now);
                    statement.setString(2, roomId);
                    if (statement.executeUpdate() != 1) {
                        throw new IllegalStateException(
                            "room state changed before match start"
                        );
                    }
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException(
                    "failed to create drawing guess match",
                    error
                );
            } finally {
                connection.setAutoCommit(true);
            }
        }
        return findMatch(matchId);
    }

    public RoundPrivate startRound(
        String matchId,
        int roundIndex,
        String drawerParticipantId,
        DrawingPrompt prompt,
        Instant startedAt,
        Instant expiresAt
    ) throws SQLException {
        Match match = findMatch(matchId);
        if (!"ACTIVE".equals(match.state())) {
            throw new IllegalStateException("match must be ACTIVE");
        }
        if (roundIndex < 0 || roundIndex >= match.totalRounds()) {
            throw new IllegalArgumentException(
                "round index is outside match range"
            );
        }
        if (drawerParticipantId == null || drawerParticipantId.isBlank()) {
            throw new IllegalArgumentException(
                "drawerParticipantId is required"
            );
        }
        if (prompt == null) {
            throw new IllegalArgumentException("prompt is required");
        }
        if (
            startedAt == null
            || expiresAt == null
            || !expiresAt.isAfter(startedAt)
        ) {
            throw new IllegalArgumentException(
                "valid round timestamps are required"
            );
        }

        String roundId = UUID.randomUUID().toString();
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO drawing_guess_round(
                      round_id, match_id, round_index,
                      drawer_participant_id, prompt_id, answer,
                      accepted_answers_json, state,
                      started_at, expires_at, drawer_score
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, 0)
                    """)) {
                    statement.setString(1, roundId);
                    statement.setString(2, matchId);
                    statement.setInt(3, roundIndex);
                    statement.setString(4, drawerParticipantId.trim());
                    statement.setString(5, prompt.promptId());
                    statement.setString(6, prompt.answer());
                    statement.setString(
                        7,
                        GSON.toJson(prompt.acceptedAnswers())
                    );
                    statement.setString(8, startedAt.toString());
                    statement.setString(9, expiresAt.toString());
                    statement.executeUpdate();
                }
                try (var statement = connection.prepareStatement("""
                    UPDATE drawing_guess_match
                    SET current_round_index = ?
                    WHERE match_id = ? AND state = 'ACTIVE'
                    """)) {
                    statement.setInt(1, roundIndex);
                    statement.setString(2, matchId);
                    if (statement.executeUpdate() != 1) {
                        throw new IllegalStateException(
                            "match state changed before round start"
                        );
                    }
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException(
                    "failed to start drawing guess round",
                    error
                );
            } finally {
                connection.setAutoCommit(true);
            }
        }
        return findRoundPrivate(roundId);
    }

    public void recordCorrectGuess(
        String roundId,
        String participantId,
        String displayName,
        int rank,
        int scoreAwarded,
        int drawerScoreAwarded,
        Instant guessedAt
    ) throws SQLException {
        if (rank < 1) {
            throw new IllegalArgumentException("rank must be at least 1");
        }
        if (scoreAwarded < 0 || drawerScoreAwarded < 0) {
            throw new IllegalArgumentException(
                "score awards must not be negative"
            );
        }
        RoundPrivate round = findRoundPrivate(roundId);
        if (!"ACTIVE".equals(round.state())) {
            throw new IllegalStateException("round must be ACTIVE");
        }

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO drawing_guess_correct_guess(
                      round_id, participant_id, display_name, rank,
                      score_awarded, drawer_score_awarded, guessed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """)) {
                    statement.setString(1, roundId);
                    statement.setString(2, participantId);
                    statement.setString(3, displayName);
                    statement.setInt(4, rank);
                    statement.setInt(5, scoreAwarded);
                    statement.setInt(6, drawerScoreAwarded);
                    statement.setString(
                        7,
                        (guessedAt == null ? Instant.now() : guessedAt)
                            .toString()
                    );
                    statement.executeUpdate();
                }

                addParticipantScore(
                    connection,
                    matchRoomId(connection, round.matchId()),
                    participantId,
                    scoreAwarded
                );
                addParticipantScoreIfPresent(
                    connection,
                    matchRoomId(connection, round.matchId()),
                    round.drawerParticipantId(),
                    drawerScoreAwarded
                );

                try (var statement = connection.prepareStatement("""
                    UPDATE drawing_guess_round
                    SET drawer_score = drawer_score + ?
                    WHERE round_id = ? AND state = 'ACTIVE'
                    """)) {
                    statement.setInt(1, drawerScoreAwarded);
                    statement.setString(2, roundId);
                    if (statement.executeUpdate() != 1) {
                        throw new IllegalStateException(
                            "round state changed before score write"
                        );
                    }
                }

                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException(
                    "failed to record drawing guess score",
                    error
                );
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    public RoundPrivate completeRound(String roundId)
        throws SQLException {
        String now = Instant.now().toString();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE drawing_guess_round
                 SET state = 'COMPLETED', completed_at = ?
                 WHERE round_id = ? AND state = 'ACTIVE'
                 """)) {
            statement.setString(1, now);
            statement.setString(2, roundId);
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException(
                    "round is not ACTIVE"
                );
            }
        }
        return findRoundPrivate(roundId);
    }

    public Match completeMatch(String matchId) throws SQLException {
        Match match = findMatch(matchId);
        String now = Instant.now().toString();
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    UPDATE drawing_guess_match
                    SET state = 'COMPLETED', completed_at = ?
                    WHERE match_id = ? AND state = 'ACTIVE'
                    """)) {
                    statement.setString(1, now);
                    statement.setString(2, matchId);
                    if (statement.executeUpdate() != 1) {
                        throw new IllegalStateException(
                            "match is not ACTIVE"
                        );
                    }
                }
                try (var statement = connection.prepareStatement("""
                    UPDATE drawing_guess_room
                    SET state = 'COMPLETED', updated_at = ?
                    WHERE room_id = ? AND state = 'ACTIVE'
                    """)) {
                    statement.setString(1, now);
                    statement.setString(2, match.roomId());
                    if (statement.executeUpdate() != 1) {
                        throw new IllegalStateException(
                            "room is not ACTIVE"
                        );
                    }
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException(
                    "failed to complete drawing guess match",
                    error
                );
            } finally {
                connection.setAutoCommit(true);
            }
        }
        return findMatch(matchId);
    }

    public Room findRoom(String roomId) throws SQLException {
        String normalized = normalizeRoomId(roomId);
        String name;
        DrawerPolicy drawerPolicy;
        String streamerId;
        ScoreProfile profile;
        ClassicScorePolicy.Config scoreConfig;
        int roundDurationSeconds;
        String state;
        String createdAt;
        String updatedAt;

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT name, drawer_policy, streamer_participant_id,
                        score_profile, score_config_json,
                        round_duration_seconds, state,
                        created_at, updated_at
                 FROM drawing_guess_room
                 WHERE room_id = ?
                 """)) {
            statement.setString(1, normalized);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new NoSuchElementException(
                        "drawing guess room not found"
                    );
                }
                name = rows.getString("name");
                drawerPolicy = DrawerPolicy.valueOf(
                    rows.getString("drawer_policy")
                );
                streamerId = rows.getString(
                    "streamer_participant_id"
                );
                profile = ScoreProfile.valueOf(
                    rows.getString("score_profile")
                );
                scoreConfig = GSON.fromJson(
                    rows.getString("score_config_json"),
                    ClassicScorePolicy.Config.class
                );
                roundDurationSeconds = rows.getInt(
                    "round_duration_seconds"
                );
                state = rows.getString("state");
                createdAt = rows.getString("created_at");
                updatedAt = rows.getString("updated_at");
            }
        }

        var participants = new ArrayList<Participant>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT participant_order, participant_id,
                        provider_id, user_id, display_name, score
                 FROM drawing_guess_participant
                 WHERE room_id = ?
                 ORDER BY participant_order
                 """)) {
            statement.setString(1, normalized);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    participants.add(
                        new Participant(
                            rows.getInt("participant_order"),
                            rows.getString("participant_id"),
                            rows.getString("provider_id"),
                            rows.getString("user_id"),
                            rows.getString("display_name"),
                            rows.getInt("score")
                        )
                    );
                }
            }
        }

        return new Room(
            normalized,
            name,
            drawerPolicy,
            streamerId,
            profile,
            scoreConfig,
            roundDurationSeconds,
            state,
            createdAt,
            updatedAt,
            List.copyOf(participants)
        );
    }

    public Match findActiveMatchByRoom(String roomId)
        throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT match_id
                 FROM drawing_guess_match
                 WHERE room_id = ? AND state = 'ACTIVE'
                 ORDER BY started_at DESC
                 LIMIT 1
                 """)) {
            statement.setString(1, normalizeRoomId(roomId));
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) return null;
                return findMatch(rows.getString(1));
            }
        }
    }

    public RoundPrivate findActiveRoundByMatch(String matchId)
        throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT round_id
                 FROM drawing_guess_round
                 WHERE match_id = ? AND state = 'ACTIVE'
                 ORDER BY round_index DESC
                 LIMIT 1
                 """)) {
            statement.setString(1, matchId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) return null;
                return findRoundPrivate(rows.getString(1));
            }
        }
    }

    public Match findMatch(String matchId) throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT room_id, state, current_round_index,
                        total_rounds, started_at, completed_at
                 FROM drawing_guess_match
                 WHERE match_id = ?
                 """)) {
            statement.setString(1, matchId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new NoSuchElementException(
                        "drawing guess match not found"
                    );
                }
                return new Match(
                    matchId,
                    rows.getString("room_id"),
                    rows.getString("state"),
                    rows.getInt("current_round_index"),
                    rows.getInt("total_rounds"),
                    rows.getString("started_at"),
                    rows.getString("completed_at")
                );
            }
        }
    }

    public RoundPrivate findRoundPrivate(String roundId)
        throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT match_id, round_index, drawer_participant_id,
                        prompt_id, answer, accepted_answers_json,
                        state, started_at, expires_at,
                        completed_at, drawer_score
                 FROM drawing_guess_round
                 WHERE round_id = ?
                 """)) {
            statement.setString(1, roundId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new NoSuchElementException(
                        "drawing guess round not found"
                    );
                }

                List<String> accepted = GSON.fromJson(
                    rows.getString("accepted_answers_json"),
                    new TypeToken<List<String>>() {}.getType()
                );
                return new RoundPrivate(
                    roundId,
                    rows.getString("match_id"),
                    rows.getInt("round_index"),
                    rows.getString("drawer_participant_id"),
                    new DrawingPrompt(
                        rows.getString("prompt_id"),
                        rows.getString("answer"),
                        accepted
                    ),
                    rows.getString("state"),
                    rows.getString("started_at"),
                    rows.getString("expires_at"),
                    rows.getString("completed_at"),
                    rows.getInt("drawer_score")
                );
            }
        }
    }

    public RoundPublic findRoundPublic(String roundId)
        throws SQLException {
        RoundPrivate privateRound = findRoundPrivate(roundId);
        var guesses = new ArrayList<CorrectGuessRecord>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT participant_id, display_name, rank,
                        score_awarded, drawer_score_awarded,
                        guessed_at
                 FROM drawing_guess_correct_guess
                 WHERE round_id = ?
                 ORDER BY rank
                 """)) {
            statement.setString(1, roundId);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    guesses.add(
                        new CorrectGuessRecord(
                            rows.getString("participant_id"),
                            rows.getString("display_name"),
                            rows.getInt("rank"),
                            rows.getInt("score_awarded"),
                            rows.getInt("drawer_score_awarded"),
                            rows.getString("guessed_at")
                        )
                    );
                }
            }
        }

        return new RoundPublic(
            privateRound.roundId(),
            privateRound.matchId(),
            privateRound.roundIndex(),
            privateRound.drawerParticipantId(),
            privateRound.state(),
            privateRound.startedAt(),
            privateRound.expiresAt(),
            privateRound.completedAt(),
            privateRound.drawerScore(),
            List.copyOf(guesses)
        );
    }

    private void updateRoomState(
        String roomId,
        String expected,
        String next
    ) throws SQLException {
        String now = Instant.now().toString();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE drawing_guess_room
                 SET state = ?, updated_at = ?
                 WHERE room_id = ? AND state = ?
                 """)) {
            statement.setString(1, next);
            statement.setString(2, now);
            statement.setString(3, normalizeRoomId(roomId));
            statement.setString(4, expected);
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException(
                    "drawing guess room state mismatch"
                );
            }
        }
    }

    private static void addParticipantScore(
        Connection connection,
        String roomId,
        String participantId,
        int delta
    ) throws SQLException {
        if (delta == 0) return;
        try (var statement = connection.prepareStatement("""
            UPDATE drawing_guess_participant
            SET score = score + ?
            WHERE room_id = ? AND participant_id = ?
            """)) {
            statement.setInt(1, delta);
            statement.setString(2, roomId);
            statement.setString(3, participantId);
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException(
                    "score target participant not found: "
                        + participantId
                );
            }
        }
    }

    private static void addParticipantScoreIfPresent(
        Connection connection,
        String roomId,
        String participantId,
        int delta
    ) throws SQLException {
        if (delta == 0) return;
        try (var statement = connection.prepareStatement("""
            UPDATE drawing_guess_participant
            SET score = score + ?
            WHERE room_id = ? AND participant_id = ?
            """)) {
            statement.setInt(1, delta);
            statement.setString(2, roomId);
            statement.setString(3, participantId);
            statement.executeUpdate();
        }
    }

    private static String matchRoomId(
        Connection connection,
        String matchId
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            SELECT room_id
            FROM drawing_guess_match
            WHERE match_id = ?
            """)) {
            statement.setString(1, matchId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new NoSuchElementException(
                        "drawing guess match not found"
                    );
                }
                return rows.getString(1);
            }
        }
    }

    private String allocateRoomCode() throws SQLException {
        for (int attempt = 0; attempt < 128; attempt += 1) {
            String candidate = randomRoomCode();
            try (var connection = database.open();
                 var statement = connection.prepareStatement("""
                     SELECT 1
                     FROM drawing_guess_room
                     WHERE room_id = ?
                     """)) {
                statement.setString(1, candidate);
                try (var rows = statement.executeQuery()) {
                    if (!rows.next()) return candidate;
                }
            }
        }
        throw new IllegalStateException(
            "failed to allocate drawing guess room code"
        );
    }

    private static List<ParticipantInput> normalizeParticipants(
        List<ParticipantInput> raw
    ) {
        if (raw == null) return List.of();

        var result = new ArrayList<ParticipantInput>();
        var seen = new java.util.LinkedHashSet<String>();
        for (ParticipantInput value : raw) {
            if (value == null) continue;
            String participantId = value.participantId() == null
                ? ""
                : value.participantId().trim();
            String displayName = value.displayName() == null
                ? ""
                : value.displayName().trim();
            if (participantId.isBlank() || displayName.isBlank()) {
                throw new IllegalArgumentException(
                    "participantId and displayName are required"
                );
            }
            if (!seen.add(participantId)) {
                throw new IllegalArgumentException(
                    "duplicate participantId: " + participantId
                );
            }

            String provider = value.provider() == null
                ? null
                : value.provider().trim().toUpperCase(Locale.ROOT);
            String userId = value.userId() == null
                ? null
                : value.userId().trim();

            result.add(
                new ParticipantInput(
                    participantId,
                    provider == null || provider.isBlank()
                        ? null
                        : provider,
                    userId == null || userId.isBlank()
                        ? null
                        : userId,
                    displayName
                )
            );
            if (result.size() > MAX_PARTICIPANTS) {
                throw new IllegalArgumentException(
                    "too many participants; max=" + MAX_PARTICIPANTS
                );
            }
        }
        return List.copyOf(result);
    }

    private static String normalizeRoomId(String value) {
        return value == null
            ? ""
            : value.trim().toUpperCase(Locale.ROOT);
    }

    private static String randomRoomCode() {
        StringBuilder code = new StringBuilder(6);
        for (int index = 0; index < 6; index += 1) {
            code.append(
                CODE_ALPHABET.charAt(
                    RANDOM.nextInt(CODE_ALPHABET.length())
                )
            );
        }
        return code.toString();
    }
}
