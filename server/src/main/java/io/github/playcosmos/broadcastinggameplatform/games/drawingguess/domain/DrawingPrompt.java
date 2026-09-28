package io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

public record DrawingPrompt(
    String promptId,
    String answer,
    List<String> acceptedAnswers
) {
    public DrawingPrompt {
        if (promptId == null || promptId.isBlank()) {
            throw new IllegalArgumentException("promptId is required");
        }
        if (answer == null || answer.isBlank()) {
            throw new IllegalArgumentException("answer is required");
        }

        var accepted = new LinkedHashSet<String>();
        accepted.add(answer.trim());
        if (acceptedAnswers != null) {
            for (String value : acceptedAnswers) {
                if (value == null || value.isBlank()) continue;
                accepted.add(value.trim());
            }
        }
        acceptedAnswers = List.copyOf(new ArrayList<>(accepted));
        answer = answer.trim();
        promptId = promptId.trim();
    }
}
