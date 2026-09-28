package io.github.playcosmos.broadcastinggameplatform.games.drawingguess;

import com.google.gson.Gson;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawerSelector;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.GuessJudge;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.ClassicGuessRound;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawingPrompt;
import java.time.Instant;
import java.util.List;

public final class DrawingGuessCoreProbe {
    private static final Gson GSON = new Gson();

    private DrawingGuessCoreProbe() {}

    public static void main(String[] args) {
        var prompt = new DrawingPrompt(
            "p1",
            "프라이팬",
            List.of("후라이팬")
        );
        var judge = new GuessJudge();

        require(
            judge.isCorrect(prompt, "  프라이 팬!! "),
            "spacing/punctuation normalization must match"
        );
        require(
            judge.isCorrect(prompt, "후라이팬"),
            "accepted alias must match"
        );
        require(
            !judge.isCorrect(prompt, "냄비"),
            "wrong answer must not match"
        );

        Instant start = Instant.parse("2026-09-28T00:00:00Z");
        var round = new ClassicGuessRound(
            "r1",
            "drawer",
            prompt,
            start,
            start.plusSeconds(60),
            judge
        );

        var drawerGuess = round.submitGuess(
            "drawer",
            "Drawer",
            "프라이팬",
            start.plusSeconds(2)
        );
        require(
            drawerGuess.drawerGuess() && !drawerGuess.accepted(),
            "drawer must not submit guesses"
        );

        var wrong = round.submitGuess(
            "p2",
            "P2",
            "냄비",
            start.plusSeconds(3)
        );
        require(
            wrong.accepted() && !wrong.correct(),
            "wrong guess must be accepted but not correct"
        );

        var first = round.submitGuess(
            "p2",
            "P2",
            "프라이팬",
            start.plusSeconds(4)
        );
        require(
            first.correct() && first.correctRank() == 1,
            "first correct rank mismatch"
        );

        var duplicate = round.submitGuess(
            "p2",
            "P2",
            "후라이팬",
            start.plusSeconds(5)
        );
        require(
            duplicate.correct()
                && duplicate.duplicateCorrect()
                && duplicate.correctRank() == 1,
            "duplicate correct guess must not create a new rank"
        );

        var second = round.submitGuess(
            "p3",
            "P3",
            "후라이팬",
            start.plusSeconds(6)
        );
        require(
            second.correct() && second.correctRank() == 2,
            "second correct rank mismatch"
        );

        String publicJson = GSON.toJson(round.publicSnapshot());
        require(
            !publicJson.contains("프라이팬")
                && !publicJson.contains("후라이팬")
                && !publicJson.contains("acceptedAnswers")
                && !publicJson.contains("answer"),
            "public snapshot must never contain answer data"
        );

        String privateJson = GSON.toJson(round.privateSnapshot());
        require(
            privateJson.contains("프라이팬")
                && privateJson.contains("후라이팬"),
            "private snapshot must contain answer data"
        );

        var streamer = new DrawerSelector(
            DrawerPolicy.STREAMER_DRAWER,
            "streamer",
            List.of("p1", "p2")
        );
        require(
            "streamer".equals(streamer.drawerForRound(7)),
            "streamer drawer must remain fixed"
        );

        var rotating = new DrawerSelector(
            DrawerPolicy.ROTATING_DRAWER,
            "",
            List.of("p1", "p2", "p3")
        );
        require(
            "p1".equals(rotating.drawerForRound(0))
                && "p2".equals(rotating.drawerForRound(1))
                && "p1".equals(rotating.drawerForRound(3)),
            "rotating drawer order mismatch"
        );

        System.out.println("Drawing Guess core probe passed.");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
