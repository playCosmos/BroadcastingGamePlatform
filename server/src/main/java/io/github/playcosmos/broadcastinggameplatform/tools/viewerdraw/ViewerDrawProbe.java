package io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

public final class ViewerDrawProbe {
    private ViewerDrawProbe() {}

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory("platform-viewer-draw-probe-");
        var database = new BoardGameDatabase(root.resolve("platform.db"));
        database.initialize();
        var service = new ViewerDrawService(database);

        var random = service.create(
            "random",
            "RANDOM",
            List.of("A", "B", "C", "C"),
            Map.of("winnerCount", 2)
        );
        require(random.entryCount() == 3, "manual entries must be deduplicated");
        random = service.freeze(random.sessionId());
        require("FROZEN".equals(random.state()), "random session must freeze");
        require(random.frozenEntryHash() != null, "frozen entry hash required");
        random = service.start(random.sessionId());
        require("COMPLETED".equals(random.state()), "random draw must complete");
        var randomResult = castMap(random.result());
        require(castList(randomResult.get("winners")).size() == 2, "two winners expected");

        var number = service.create(
            "numbers",
            "NUMBER",
            List.of(),
            Map.of("maxNumber", 45, "drawCount", 7)
        );
        number = service.freeze(number.sessionId());
        number = service.start(number.sessionId());
        var numberResult = castMap(number.result());
        var numbers = castList(numberResult.get("numbers"));
        require(numbers.size() == 7, "seven numbers expected");
        require(new java.util.HashSet<>(numbers).size() == 7, "number draw must be unique");
        require(
            numbers.stream().allMatch(value -> {
                int n = ((Number) value).intValue();
                return n >= 1 && n <= 45;
            }),
            "numbers must remain within range"
        );

        require(service.recent(10).size() == 2, "history must persist both draws");

        System.out.println("Viewer Draw probe passed.");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
