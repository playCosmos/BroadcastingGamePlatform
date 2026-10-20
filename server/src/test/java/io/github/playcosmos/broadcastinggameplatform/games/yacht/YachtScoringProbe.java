package io.github.playcosmos.broadcastinggameplatform.games.yacht;

import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring.Category;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring.Sheet;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/** Pure scoring test: no provider SDK, browser, DB or dice RNG required. */
public final class YachtScoringProbe {
    private static long assertions;
    private YachtScoringProbe() {}

    public static void main(String[] args) {
        require(Category.values().length == 13, "13 scoring categories");
        for (Category cat : Category.values()) {
            require(Category.fromId(cat.id()) == cat, "stable persistence ID");
        }
        rejected(() -> Category.fromId("invalid"), "unknown category");
        rejected(() -> YachtScoring.score(new int[0], Category.ACES),
            "wrong dice count");
        rejected(() -> YachtScoring.score(new int[]{1, 2, 3, 4, 7}, Category.CHANCE),
            "die outside 1..6");
        rejected(() -> YachtScoring.score(new int[]{0, 2, 3, 4, 5}, Category.CHANCE),
            "zero-valued die");
        rejected(() -> YachtScoring.choices(null, new int[]{1, 1, 1, 1, 1}),
            "null score sheet");

        // Exhaustive 6^5 = 7,776 five-die outcomes against independent
        // reference predicates, plus permutation stability for all 13 categories.
        int[] dice = new int[5];
        for (int code = 0; code < 7776; code++) {
            int input = code;
            for (int i = 0; i < 5; i++) {
                dice[i] = input % 6 + 1;
                input /= 6;
            }
            int[] rotated = {dice[3], dice[4], dice[0], dice[1], dice[2]};
            for (Category cat : Category.values()) {
                int actual = YachtScoring.score(dice, cat);
                require(actual == referenceScore(dice, cat),
                    "incorrect score for " + cat + " / dice-code=" + code);
                require(actual == YachtScoring.score(rotated, cat),
                    "score depends on dice order");
                require(actual >= 0, "nonnegative scoring");
            }
            var options = YachtScoring.choices(Sheet.empty(), dice);
            require(!options.repeatYachtBonus() && options.points().size() == 13,
                "empty sheet permits all categories without Joker");
            for (Category cat : Category.values()) {
                require(options.points().get(cat) == referenceScore(dice, cat),
                    "unmodified empty scorecard differs from reference");
            }
        }

        require(YachtScoring.score(d(2, 2, 2, 2, 2), Category.FULL_HOUSE) == 0,
            "five of a kind is not an ordinary full house");
        require(YachtScoring.score(d(1, 2, 2, 3, 4), Category.SMALL_STRAIGHT) == 30,
            "duplicate faces allowed in small straight");
        require(YachtScoring.score(d(1, 2, 3, 4, 6), Category.SMALL_STRAIGHT) == 30,
            "one 1–4 straight");
        require(YachtScoring.score(d(2, 3, 4, 5, 5), Category.SMALL_STRAIGHT) == 30,
            "one 2–5 straight");
        require(YachtScoring.score(d(2, 3, 4, 5, 6), Category.LARGE_STRAIGHT) == 40,
            "2–6 large straight");
        require(YachtScoring.score(d(1, 2, 3, 4, 5), Category.LARGE_STRAIGHT) == 40,
            "1–5 large straight");
        require(YachtScoring.score(d(1, 1, 1, 3, 3), Category.FULL_HOUSE) == 25,
            "standard 3+2 full house");
        require(YachtScoring.score(d(6, 6, 6, 2, 3), Category.THREE_OF_KIND) == 23,
            "three of kind counts all dice");
        require(YachtScoring.score(d(6, 6, 6, 6, 3), Category.FOUR_OF_KIND) == 27,
            "four of kind counts all dice");

        var upper63 = new EnumMap<Category, Integer>(Category.class);
        for (int face = 1; face <= 6; face++) {
            upper63.put(Category.values()[face - 1], face * 3);
        }
        var bonus = new Sheet(upper63, 0);
        require(bonus.upperSubtotal() == 63 && bonus.upperBonus() == 35
            && bonus.total() == 98, "63-point upper bonus");
        upper63.put(Category.ACES, 2);
        var below = new Sheet(upper63, 0);
        require(below.upperSubtotal() == 62 && below.upperBonus() == 0,
            "no bonus at 62");
        upper63.clear();
        require(bonus.upperSubtotal() == 63,
            "stored score sheets are immutable copies");
        rejected(() -> bonus.scores().put(Category.YACHT, 50),
            "score sheet must reject mutation");

        var originalYacht = new Sheet(Map.of(Category.YACHT, 50), 0);
        int[] tripleFives = d(5, 5, 5, 5, 5);
        var forced = YachtScoring.choices(originalYacht, tripleFives);
        require(forced.repeatYachtBonus()
            && forced.points().equals(Map.of(Category.FIVES, 25)),
            "Joker first forces matching upper category");
        rejected(() -> YachtScoring.commit(originalYacht,
            tripleFives, Category.FULL_HOUSE), "matching upper cannot be skipped");
        var scoredUpper = YachtScoring.commit(originalYacht,
            tripleFives, Category.FIVES);
        require(scoredUpper.repeatYachtCount() == 1
            && scoredUpper.repeatYachtBonus() == 100
            && scoredUpper.scores().get(Category.FIVES) == 25,
            "one repeat bonus on scoring commit");
        require(originalYacht.repeatYachtCount() == 0,
            "repeat bonus must not be awarded at mere dice evaluation");
        var freeLower = YachtScoring.choices(scoredUpper, tripleFives);
        require(freeLower.repeatYachtBonus() && freeLower.allowed(Category.FULL_HOUSE)
            && freeLower.points().get(Category.FULL_HOUSE) == 25
            && freeLower.points().get(Category.SMALL_STRAIGHT) == 30
            && freeLower.points().get(Category.LARGE_STRAIGHT) == 40
            && freeLower.points().get(Category.THREE_OF_KIND) == 25
            && freeLower.points().get(Category.FOUR_OF_KIND) == 25
            && freeLower.points().get(Category.CHANCE) == 25,
            "Joker lower fixed-score and sum-score rules");
        require(!freeLower.allowed(Category.ACES),
            "matching filled upper forces an available lower");
        var scoredLower = YachtScoring.commit(scoredUpper,
            tripleFives, Category.LARGE_STRAIGHT);
        require(scoredLower.repeatYachtCount() == 2
            && scoredLower.scores().get(Category.LARGE_STRAIGHT) == 40,
            "repeat Yacht lower Joker and bonus");

        var filledLower = new EnumMap<Category, Integer>(Category.class);
        for (Category category : Category.values()) {
            if (!category.upper()) filledLower.put(category,
                category == Category.YACHT ? 50 : 0);
        }
        filledLower.put(Category.FIVES, 25);
        var fallback = YachtScoring.choices(new Sheet(filledLower, 0), tripleFives);
        require(fallback.repeatYachtBonus() && fallback.points().size() == 5,
            "forced fallback offers only remaining upper");
        require(fallback.points().values().stream().allMatch(v -> v == 0),
            "forced other-upper fallback scores zero");
        rejected(() -> YachtScoring.commit(new Sheet(filledLower, 0),
            tripleFives, Category.FIVES), "cannot reuse filled category");
        var scoredFallback = YachtScoring.commit(new Sheet(filledLower, 0),
            tripleFives, Category.ACES);
        require(scoredFallback.scores().get(Category.ACES) == 0
            && scoredFallback.repeatYachtBonus() == 100,
            "fallback upper zero with repeat bonus");

        var zeroYacht = new Sheet(Map.of(Category.YACHT, 0), 0);
        var noJoker = YachtScoring.choices(zeroYacht, tripleFives);
        require(!noJoker.repeatYachtBonus()
            && noJoker.points().size() == 12
            && noJoker.points().get(Category.FULL_HOUSE) == 0,
            "zero-scored Yacht cannot enable repeat bonus/Joker");
        require(YachtScoring.commit(zeroYacht,
            tripleFives, Category.CHANCE).repeatYachtCount() == 0,
            "no repeated bonus after zero yacht");

        Sheet full = Sheet.empty();
        for (Category category : Category.values()) {
            full = YachtScoring.commit(full, d(1, 2, 3, 4, 5), category);
        }
        require(full.complete()
            && YachtScoring.choices(full, d(1, 2, 3, 4, 5)).points().isEmpty(),
            "exactly 13 committed categories exhaust sheet");
        Sheet finalFull = full;
        rejected(() -> YachtScoring.commit(finalFull, d(1, 2, 3, 4, 5),
            Category.ACES), "no scoring after card complete");

        rejected(() -> new Sheet(Map.of(Category.YACHT, 0), 1),
            "repeat bonuses cannot exist with zero Yacht");
        rejected(() -> new Sheet(Map.of(Category.ACES, -1), 0),
            "negative committed points");
        rejected(() -> new Sheet(Map.of(Category.FULL_HOUSE, 19), 0),
            "malformed persisted fixed-score category");
        rejected(() -> new Sheet(Map.of(Category.SIXES, 7), 0),
            "malformed persisted upper subtotal");
        rejected(() -> new Sheet(Map.of(Category.YACHT, 50), 13),
            "excess repeat bonus entries");
        System.out.println("YACHT_Y0_PASSED cases=7776 categories=13 assertions="
            + assertions + " joker=priority,bonus,fallback"
            + " upper=62,63 immutable=true");
    }

    private static int[] d(int a, int b, int c, int d, int e) {
        return new int[]{a, b, c, d, e};
    }

    private static int referenceScore(int[] dice, Category category) {
        int[] counts = new int[7];
        int sum = 0;
        for (int face : dice) { counts[face]++; sum += face; }
        if (category.upper()) {
            int target = category.ordinal() + 1;
            return counts[target] * target;
        }
        return switch (category) {
            case THREE_OF_KIND ->
                hasAtLeast(counts, 3) ? sum : 0;
            case FOUR_OF_KIND ->
                hasAtLeast(counts, 4) ? sum : 0;
            case YACHT -> hasAtLeast(counts, 5) ? 50 : 0;
            case FULL_HOUSE ->
                hasExact(counts, 3) && hasExact(counts, 2) ? 25 : 0;
            case SMALL_STRAIGHT -> {
                boolean found = false;
                for (int start = 1; start <= 3; start++) {
                    boolean consecutive = true;
                    for (int face = start; face < start + 4; face++) {
                        consecutive &= counts[face] > 0;
                    }
                    found |= consecutive;
                }
                yield found ? 30 : 0;
            }
            case LARGE_STRAIGHT -> {
                boolean low = true, high = true;
                for (int face = 1; face <= 5; face++) low &= counts[face] == 1;
                for (int face = 2; face <= 6; face++) high &= counts[face] == 1;
                yield low || high ? 40 : 0;
            }
            case CHANCE -> sum;
            default -> throw new AssertionError("unknown lower category");
        };
    }

    private static boolean hasAtLeast(int[] counts, int n) {
        for (int count : counts) if (count >= n) return true;
        return false;
    }
    private static boolean hasExact(int[] counts, int n) {
        for (int count : counts) if (count == n) return true;
        return false;
    }

    private static void require(boolean okay, String message) {
        assertions++;
        if (!okay) throw new IllegalStateException(message);
    }
    private static void rejected(Runnable action, String message) {
        assertions++;
        try { action.run(); }
        catch (IllegalArgumentException | UnsupportedOperationException expected) { return; }
        throw new IllegalStateException("did not reject: " + message);
    }
}
