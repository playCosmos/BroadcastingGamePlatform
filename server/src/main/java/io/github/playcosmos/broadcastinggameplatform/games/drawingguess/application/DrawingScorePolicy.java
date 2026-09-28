package io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application;

import java.time.Duration;

public interface DrawingScorePolicy {
    record ScoreContext(
        Duration roundDuration,
        Duration elapsed,
        int correctRank,
        int eligibleGuessers
    ) {}

    record ScoreAward(
        int guesserPoints,
        int drawerPoints
    ) {}

    ScoreAward score(ScoreContext context);
}
