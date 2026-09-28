package io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application;

import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.ScoreProfile;
import java.time.Duration;

public final class ClassicScorePolicy implements DrawingScorePolicy {
    public record Config(
        ScoreProfile profile,
        int maxGuessPoints,
        int minGuessPoints,
        int rankPenaltyPoints,
        int drawerPointsPerCorrect
    ) {
        public Config {
            profile = profile == null ? ScoreProfile.FAST_GUESS : profile;
            if (maxGuessPoints < 0) {
                throw new IllegalArgumentException(
                    "maxGuessPoints must not be negative"
                );
            }
            if (minGuessPoints < 0 || minGuessPoints > maxGuessPoints) {
                throw new IllegalArgumentException(
                    "minGuessPoints must be within 0..maxGuessPoints"
                );
            }
            if (rankPenaltyPoints < 0) {
                throw new IllegalArgumentException(
                    "rankPenaltyPoints must not be negative"
                );
            }
            if (drawerPointsPerCorrect < 0) {
                throw new IllegalArgumentException(
                    "drawerPointsPerCorrect must not be negative"
                );
            }
        }

        public static Config defaults() {
            return new Config(
                ScoreProfile.FAST_GUESS,
                500,
                100,
                25,
                50
            );
        }
    }

    private final Config config;

    public ClassicScorePolicy(Config config) {
        this.config = config == null ? Config.defaults() : config;
    }

    public Config config() {
        return config;
    }

    @Override
    public ScoreAward score(ScoreContext context) {
        if (context == null) {
            throw new IllegalArgumentException("score context is required");
        }
        if (context.correctRank() < 1) {
            throw new IllegalArgumentException(
                "correctRank must be at least 1"
            );
        }

        return switch (config.profile()) {
            case NO_SCORE -> new ScoreAward(0, 0);
            case RANKED -> ranked(context);
            case FAST_GUESS -> fastGuess(context);
        };
    }

    private ScoreAward ranked(ScoreContext context) {
        int rank = context.correctRank();
        int guesserPoints = Math.max(
            config.minGuessPoints(),
            config.maxGuessPoints()
                - ((rank - 1) * config.rankPenaltyPoints())
        );
        return new ScoreAward(
            guesserPoints,
            config.drawerPointsPerCorrect()
        );
    }

    private ScoreAward fastGuess(ScoreContext context) {
        Duration roundDuration = positiveDuration(
            context.roundDuration()
        );
        Duration elapsed = context.elapsed() == null
            ? Duration.ZERO
            : context.elapsed();

        long totalMillis = Math.max(1L, roundDuration.toMillis());
        long elapsedMillis = Math.max(
            0L,
            Math.min(totalMillis, elapsed.toMillis())
        );
        double remainingRatio =
            (double) (totalMillis - elapsedMillis)
                / (double) totalMillis;

        int timed = config.minGuessPoints()
            + (int) Math.round(
                (config.maxGuessPoints() - config.minGuessPoints())
                    * remainingRatio
            );

        int rankPenalty = Math.max(
            0,
            context.correctRank() - 1
        ) * config.rankPenaltyPoints();

        int guesserPoints = Math.max(
            config.minGuessPoints(),
            timed - rankPenalty
        );

        return new ScoreAward(
            guesserPoints,
            config.drawerPointsPerCorrect()
        );
    }

    private static Duration positiveDuration(Duration value) {
        if (
            value == null
            || value.isZero()
            || value.isNegative()
        ) {
            throw new IllegalArgumentException(
                "roundDuration must be positive"
            );
        }
        return value;
    }
}
