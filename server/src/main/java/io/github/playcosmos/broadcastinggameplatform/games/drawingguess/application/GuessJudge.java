package io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application;

import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawingPrompt;
import java.text.Normalizer;
import java.util.Locale;

public final class GuessJudge {
    public boolean isCorrect(DrawingPrompt prompt, String guess) {
        if (prompt == null || guess == null || guess.isBlank()) return false;
        String normalizedGuess = normalize(guess);
        if (normalizedGuess.isBlank()) return false;

        for (String accepted : prompt.acceptedAnswers()) {
            if (normalize(accepted).equals(normalizedGuess)) {
                return true;
            }
        }
        return false;
    }

    public String normalize(String value) {
        if (value == null) return "";
        String normalized = Normalizer.normalize(
            value,
            Normalizer.Form.NFKC
        ).toLowerCase(Locale.ROOT);

        StringBuilder result = new StringBuilder(normalized.length());
        normalized.codePoints().forEach(codePoint -> {
            int type = Character.getType(codePoint);
            if (
                Character.isWhitespace(codePoint)
                || type == Character.SPACE_SEPARATOR
                || type == Character.LINE_SEPARATOR
                || type == Character.PARAGRAPH_SEPARATOR
                || isPunctuation(type)
            ) {
                return;
            }
            result.appendCodePoint(codePoint);
        });
        return result.toString();
    }

    private static boolean isPunctuation(int type) {
        return type == Character.CONNECTOR_PUNCTUATION
            || type == Character.DASH_PUNCTUATION
            || type == Character.START_PUNCTUATION
            || type == Character.END_PUNCTUATION
            || type == Character.INITIAL_QUOTE_PUNCTUATION
            || type == Character.FINAL_QUOTE_PUNCTUATION
            || type == Character.OTHER_PUNCTUATION;
    }
}
