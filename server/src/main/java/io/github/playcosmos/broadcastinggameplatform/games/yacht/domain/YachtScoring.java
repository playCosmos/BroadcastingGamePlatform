package io.github.playcosmos.broadcastinggameplatform.games.yacht.domain;

import java.util.Collections;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Server-authoritative Yacht / Yahtzee-style 13-category scoring.
 * Pure rules: no HTTP, database, provider, display or randomness dependency.
 */
public final class YachtScoring {
    private YachtScoring() {}

    public enum Category {
        ACES("aces", true), TWOS("twos", true),
        THREES("threes", true), FOURS("fours", true),
        FIVES("fives", true), SIXES("sixes", true),
        THREE_OF_KIND("three_of_kind", false),
        FOUR_OF_KIND("four_of_kind", false),
        FULL_HOUSE("full_house", false),
        SMALL_STRAIGHT("small_straight", false),
        LARGE_STRAIGHT("large_straight", false),
        YACHT("yacht", false), CHANCE("chance", false);

        private final String id;
        private final boolean upper;

        Category(String id, boolean upper) {
            this.id = id;
            this.upper = upper;
        }

        public String id() { return id; }
        public boolean upper() { return upper; }

        public static Category fromId(String id) {
            for (Category category : values()) {
                if (category.id.equals(id)) return category;
            }
            throw new IllegalArgumentException("unknown Yacht score category");
        }
    }

    /** Immutable scorecard. Scores are the committed values, not predictions. */
    public record Sheet(Map<Category, Integer> scores, int repeatYachtCount) {
        public Sheet {
            Objects.requireNonNull(scores, "scores");
            if (repeatYachtCount < 0 || repeatYachtCount > 12) {
                throw new IllegalArgumentException("invalid repeat Yacht count");
            }
            var copy = new EnumMap<Category, Integer>(Category.class);
            for (var entry : scores.entrySet()) {
                if (entry.getKey() == null || entry.getValue() == null) {
                    throw new IllegalArgumentException("null score entry");
                }
                int value = entry.getValue();
                Category category = entry.getKey();
                if (value < 0 || value > maxScore(category)
                    || (category.upper() && value % (category.ordinal() + 1) != 0)
                    || (category == Category.FULL_HOUSE && value != 0 && value != 25)
                    || (category == Category.SMALL_STRAIGHT && value != 0 && value != 30)
                    || (category == Category.LARGE_STRAIGHT && value != 0 && value != 40)
                    || (category == Category.YACHT && value != 0 && value != 50)) {
                    throw new IllegalArgumentException("invalid score entry");
                }
                copy.put(category, value);
            }
            if (repeatYachtCount > 0
                && !Integer.valueOf(50).equals(copy.get(Category.YACHT))) {
                throw new IllegalArgumentException("repeat bonus requires a 50-point Yacht");
            }
            if (repeatYachtCount > Math.max(0, copy.size() - 1)) {
                throw new IllegalArgumentException("too many repeat bonuses");
            }
            scores = Collections.unmodifiableMap(copy);
        }

        public static Sheet empty() { return new Sheet(Map.of(), 0); }
        public boolean used(Category category) { return scores.containsKey(category); }
        public boolean complete() { return scores.size() == Category.values().length; }

        public int upperSubtotal() {
            return scores.entrySet().stream()
                .filter(e -> e.getKey().upper())
                .mapToInt(Map.Entry::getValue).sum();
        }
        public int upperBonus() { return upperSubtotal() >= 63 ? 35 : 0; }
        public int lowerSubtotal() {
            return scores.entrySet().stream()
                .filter(e -> !e.getKey().upper())
                .mapToInt(Map.Entry::getValue).sum();
        }
        public int repeatYachtBonus() { return repeatYachtCount * 100; }
        public int total() {
            return upperSubtotal() + upperBonus()
                + lowerSubtotal() + repeatYachtBonus();
        }
    }

    /** Exact legal score options for this turn, including forced Joker choices. */
    public record Choices(Map<Category, Integer> points, boolean repeatYachtBonus) {
        public Choices {
            Objects.requireNonNull(points, "points");
            points = Collections.unmodifiableMap(new LinkedHashMap<>(points));
        }

        public boolean allowed(Category category) { return points.containsKey(category); }
    }

    /** Strict base category points; no scorecard or Joker modifier is applied. */
    public static int score(int[] dice, Category category) {
        Objects.requireNonNull(category, "category");
        int[] counts = count(dice);
        int sum = 0;
        int uniqueMask = 0;
        boolean pair = false;
        boolean triple = false;
        boolean quadruple = false;
        boolean five = false;
        for (int face = 1; face <= 6; face++) {
            sum += face * counts[face];
            if (counts[face] > 0) uniqueMask |= 1 << (face - 1);
            if (counts[face] == 2) pair = true;
            if (counts[face] == 3) triple = true;
            if (counts[face] >= 4) quadruple = true;
            if (counts[face] == 5) five = true;
        }
        return switch (category) {
            case ACES, TWOS, THREES, FOURS, FIVES, SIXES -> {
                int face = category.ordinal() + 1;
                yield face * counts[face];
            }
            case THREE_OF_KIND ->
                triple || quadruple || five ? sum : 0;
            case FOUR_OF_KIND -> quadruple || five ? sum : 0;
            case FULL_HOUSE -> triple && pair ? 25 : 0;
            case SMALL_STRAIGHT ->
                (uniqueMask & 15) == 15 || (uniqueMask & 30) == 30
                    || (uniqueMask & 60) == 60 ? 30 : 0;
            case LARGE_STRAIGHT ->
                uniqueMask == 31 || uniqueMask == 62 ? 40 : 0;
            case YACHT -> five ? 50 : 0;
            case CHANCE -> sum;
        };
    }

    /**
     * On a later five-of-kind AFTER Yacht was scored 50, apply Joker priority:
     * matching upper if unused; otherwise any free lower; otherwise a free
     * upper scored zero. A 0-scored Yacht never activates Joker or +100.
     */
    public static Choices choices(Sheet sheet, int[] dice) {
        Objects.requireNonNull(sheet, "sheet");
        int[] counts = count(dice);
        if (sheet.complete()) return new Choices(Map.of(), false);
        boolean five = false;
        int matchingFace = 0;
        for (int face = 1; face <= 6; face++) {
            if (counts[face] == 5) {
                five = true;
                matchingFace = face;
            }
        }
        boolean repeat = five && Integer.valueOf(50).equals(
            sheet.scores().get(Category.YACHT));
        var allowed = new LinkedHashMap<Category, Integer>();
        if (repeat) {
            Category matchingUpper = Category.values()[matchingFace - 1];
            if (!sheet.used(matchingUpper)) {
                allowed.put(matchingUpper, 5 * matchingFace);
                return new Choices(allowed, true);
            }
            for (Category category : Category.values()) {
                if (!category.upper() && !sheet.used(category)) {
                    int value = switch (category) {
                        case FULL_HOUSE -> 25;
                        case SMALL_STRAIGHT -> 30;
                        case LARGE_STRAIGHT -> 40;
                        default -> score(dice, category);
                    };
                    allowed.put(category, value);
                }
            }
            if (!allowed.isEmpty()) return new Choices(allowed, true);
            for (Category category : Category.values()) {
                if (category.upper() && !sheet.used(category)) allowed.put(category, 0);
            }
            return new Choices(allowed, true);
        }
        for (Category category : Category.values()) {
            if (!sheet.used(category)) allowed.put(category, score(dice, category));
        }
        return new Choices(allowed, false);
    }

    /**
     * The +100 bonus is credited once on a committed scoring turn, not on
     * every intermediate reroll. That prevents unlimited extra scores.
     */
    public static Sheet commit(Sheet sheet, int[] dice, Category category) {
        Objects.requireNonNull(category, "category");
        Choices options = choices(sheet, dice);
        Integer points = options.points().get(category);
        if (points == null) {
            throw new IllegalArgumentException("Yacht category unavailable or Joker-forbidden");
        }
        var updated = new EnumMap<Category, Integer>(Category.class);
        updated.putAll(sheet.scores());
        updated.put(category, points);
        return new Sheet(updated, sheet.repeatYachtCount()
            + (options.repeatYachtBonus() ? 1 : 0));
    }

    private static int maxScore(Category category) {
        if (category.upper()) return 5 * (category.ordinal() + 1);
        return switch (category) {
            case FULL_HOUSE -> 25;
            case SMALL_STRAIGHT -> 30;
            case LARGE_STRAIGHT -> 40;
            case YACHT -> 50;
            default -> 30;
        };
    }

    private static int[] count(int[] dice) {
        if (dice == null || dice.length != 5) {
            throw new IllegalArgumentException("Yacht needs exactly five dice");
        }
        int[] counts = new int[7];
        for (int die : dice) {
            if (die < 1 || die > 6) {
                throw new IllegalArgumentException("dice must be in 1..6");
            }
            counts[die]++;
        }
        return counts;
    }
}
