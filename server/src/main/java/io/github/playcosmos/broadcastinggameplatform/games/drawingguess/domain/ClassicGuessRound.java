package io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain;

import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.GuessJudge;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

public final class ClassicGuessRound {
    public enum State {
        ACTIVE,
        COMPLETED
    }

    public record CorrectGuess(
        String participantId,
        String displayName,
        int rank,
        String guessedAt
    ) {}

    public record GuessResult(
        boolean accepted,
        boolean correct,
        boolean duplicateCorrect,
        boolean drawerGuess,
        int correctRank
    ) {}

    public record PublicSnapshot(
        String roundId,
        String drawerParticipantId,
        State state,
        String startedAt,
        String expiresAt,
        int correctCount,
        List<CorrectGuess> correctGuesses
    ) {}

    public record PrivateSnapshot(
        PublicSnapshot publicState,
        String promptId,
        String answer,
        List<String> acceptedAnswers
    ) {}

    private final String roundId;
    private final String drawerParticipantId;
    private final DrawingPrompt prompt;
    private final Instant startedAt;
    private final Instant expiresAt;
    private final GuessJudge judge;
    private final LinkedHashSet<String> correctParticipantIds =
        new LinkedHashSet<>();
    private final ArrayList<CorrectGuess> correctGuesses =
        new ArrayList<>();
    private State state = State.ACTIVE;

    public ClassicGuessRound(
        String roundId,
        String drawerParticipantId,
        DrawingPrompt prompt,
        Instant startedAt,
        Instant expiresAt,
        GuessJudge judge
    ) {
        if (roundId == null || roundId.isBlank()) {
            throw new IllegalArgumentException("roundId is required");
        }
        if (drawerParticipantId == null || drawerParticipantId.isBlank()) {
            throw new IllegalArgumentException(
                "drawerParticipantId is required"
            );
        }
        if (prompt == null) {
            throw new IllegalArgumentException("prompt is required");
        }
        if (startedAt == null || expiresAt == null) {
            throw new IllegalArgumentException(
                "round timestamps are required"
            );
        }
        if (!expiresAt.isAfter(startedAt)) {
            throw new IllegalArgumentException(
                "expiresAt must be after startedAt"
            );
        }

        this.roundId = roundId.trim();
        this.drawerParticipantId = drawerParticipantId.trim();
        this.prompt = prompt;
        this.startedAt = startedAt;
        this.expiresAt = expiresAt;
        this.judge = judge == null ? new GuessJudge() : judge;
    }

    public synchronized GuessResult submitGuess(
        String participantId,
        String displayName,
        String guess,
        Instant guessedAt
    ) {
        if (state != State.ACTIVE) {
            return new GuessResult(false, false, false, false, 0);
        }

        Instant now = guessedAt == null ? Instant.now() : guessedAt;
        if (!now.isBefore(expiresAt)) {
            state = State.COMPLETED;
            return new GuessResult(false, false, false, false, 0);
        }

        String normalizedParticipantId = participantId == null
            ? ""
            : participantId.trim();
        if (normalizedParticipantId.isBlank()) {
            return new GuessResult(false, false, false, false, 0);
        }

        if (drawerParticipantId.equals(normalizedParticipantId)) {
            return new GuessResult(false, false, false, true, 0);
        }

        boolean correct = judge.isCorrect(prompt, guess);
        if (!correct) {
            return new GuessResult(true, false, false, false, 0);
        }

        if (!correctParticipantIds.add(normalizedParticipantId)) {
            int rank = rankOf(normalizedParticipantId);
            return new GuessResult(true, true, true, false, rank);
        }

        int rank = correctGuesses.size() + 1;
        correctGuesses.add(
            new CorrectGuess(
                normalizedParticipantId,
                displayName == null || displayName.isBlank()
                    ? normalizedParticipantId
                    : displayName.trim(),
                rank,
                now.toString()
            )
        );
        return new GuessResult(true, true, false, false, rank);
    }

    public synchronized void complete() {
        state = State.COMPLETED;
    }

    public synchronized PublicSnapshot publicSnapshot() {
        return new PublicSnapshot(
            roundId,
            drawerParticipantId,
            state,
            startedAt.toString(),
            expiresAt.toString(),
            correctGuesses.size(),
            List.copyOf(correctGuesses)
        );
    }

    public synchronized PrivateSnapshot privateSnapshot() {
        return new PrivateSnapshot(
            publicSnapshot(),
            prompt.promptId(),
            prompt.answer(),
            prompt.acceptedAnswers()
        );
    }

    private int rankOf(String participantId) {
        for (CorrectGuess correct : correctGuesses) {
            if (correct.participantId().equals(participantId)) {
                return correct.rank();
            }
        }
        return 0;
    }
}
