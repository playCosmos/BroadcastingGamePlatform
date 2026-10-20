package io.github.playcosmos.broadcastinggameplatform.games.yacht.domain;

import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring.Category;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring.Sheet;
import java.security.SecureRandom;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

/**
 * Immutable, server-authoritative Yacht turn/match state. The client is never
 * allowed to supply die results; pure transitions make persistence and replay
 * tests deterministic without recording or exposing RNG seeds.
 */
public record YachtMatchState(
    String id, String name, List<Player> players, Phase phase,
    int currentPlayer, int completedTurns, int rolls,
    List<Integer> dice, List<Boolean> held, long version
) {
    public enum Phase { READY, ACTIVE, PAUSED, FINISHED, CLOSED }

    public record Player(String id, String displayName, Sheet sheet) {
        public Player {
            if (id == null || !id.matches("[A-Za-z0-9_-]{1,64}")) {
                throw new IllegalArgumentException("invalid Yacht participant ID");
            }
            if (displayName == null || displayName.isBlank()
                || displayName.length() > 80) {
                throw new IllegalArgumentException("invalid Yacht participant display name");
            }
            Objects.requireNonNull(sheet, "sheet");
        }
    }

    @FunctionalInterface
    public interface DiceRandomSource {
        /** Must return 1–6. This interface is only injected on the server. */
        int nextFace();
    }

    public static final class SecureDiceRandomSource implements DiceRandomSource {
        private final SecureRandom random = new SecureRandom();
        @Override public int nextFace() { return random.nextInt(6) + 1; }
    }

    private static final List<Integer> EMPTY_DICE = List.of(0, 0, 0, 0, 0);
    private static final List<Boolean> NO_HOLD =
        List.of(false, false, false, false, false);

    public YachtMatchState {
        if (id == null || !id.matches("[A-Za-z0-9-]{1,64}")) {
            throw new IllegalArgumentException("invalid match ID");
        }
        if (name == null || name.isBlank() || name.length() > 100) {
            throw new IllegalArgumentException("invalid Yacht match name");
        }
        Objects.requireNonNull(players, "players");
        players = List.copyOf(players);
        if (players.size() < 2 || players.size() > 6) {
            throw new IllegalArgumentException("Yacht requires 2–6 participants");
        }
        var playerIds = new HashSet<String>();
        for (Player player : players) {
            if (!playerIds.add(player.id())) {
                throw new IllegalArgumentException("duplicate Yacht participant");
            }
        }
        Objects.requireNonNull(phase, "phase");
        Objects.requireNonNull(dice, "dice");
        Objects.requireNonNull(held, "held");
        dice = List.copyOf(dice);
        held = List.copyOf(held);
        if (dice.size() != 5 || held.size() != 5) {
            throw new IllegalArgumentException("five dice and hold values required");
        }
        if (version < 0 || rolls < 0 || rolls > 3 || currentPlayer < 0
            || currentPlayer >= players.size() || completedTurns < 0
            || completedTurns > players.size() * 13) {
            throw new IllegalArgumentException("invalid Yacht match counters");
        }
        int committed = players.stream().mapToInt(p -> p.sheet().scores().size()).sum();
        if (completedTurns != committed
            || currentPlayer != completedTurns % players.size()) {
            throw new IllegalArgumentException("inconsistent turn/player totals");
        }
        for (int i = 0; i < players.size(); i++) {
            int expected = completedTurns / players.size()
                + (i < completedTurns % players.size() ? 1 : 0);
            if (players.get(i).sheet().scores().size() != expected) {
                throw new IllegalArgumentException("inconsistent scorecard turn ordering");
            }
        }
        if ((phase == Phase.FINISHED && completedTurns != players.size() * 13)
            || (completedTurns == players.size() * 13
                && phase != Phase.FINISHED && phase != Phase.CLOSED)
            || (phase == Phase.READY && (completedTurns != 0 || rolls != 0))) {
            throw new IllegalArgumentException("invalid Yacht match lifecycle");
        }
        for (int index = 0; index < 5; index++) {
            int face = dice.get(index);
            if (rolls == 0 && (face != 0 || held.get(index))) {
                throw new IllegalArgumentException("cannot hold or show unrolled dice");
            }
            if (rolls > 0 && (face < 1 || face > 6)) {
                throw new IllegalArgumentException("invalid active dice");
            }
        }
        if ((phase == Phase.READY || phase == Phase.FINISHED
            || phase == Phase.CLOSED) && rolls != 0) {
            throw new IllegalArgumentException("inactive match has a pending roll");
        }
    }

    public static YachtMatchState create(String name, List<Player> players) {
        return new YachtMatchState(UUID.randomUUID().toString(), name, players,
            Phase.READY, 0, 0, 0, EMPTY_DICE, NO_HOLD, 0);
    }

    public static List<Integer> emptyDice() { return EMPTY_DICE; }
    public static List<Boolean> noHold() { return NO_HOLD; }

    public Player activePlayer() { return players.get(currentPlayer); }
    public int roundNumber() { return completedTurns / players.size() + 1; }

    public YachtMatchState start() {
        if (phase != Phase.READY) throw new IllegalStateException("match not ready");
        return transitioned(players, Phase.ACTIVE, 0, 0, 0, EMPTY_DICE, NO_HOLD);
    }

    public YachtMatchState pause() {
        requireActive();
        return transitioned(players, Phase.PAUSED, currentPlayer,
            completedTurns, rolls, dice, held);
    }

    public YachtMatchState resume() {
        if (phase != Phase.PAUSED) throw new IllegalStateException("match not paused");
        return transitioned(players, Phase.ACTIVE, currentPlayer,
            completedTurns, rolls, dice, held);
    }

    public YachtMatchState roll(DiceRandomSource source) {
        requireActive();
        Objects.requireNonNull(source, "random source");
        if (rolls == 3) throw new IllegalStateException("three rolls exhausted");
        var next = new java.util.ArrayList<Integer>(dice);
        for (int i = 0; i < 5; i++) {
            if (rolls == 0 || !held.get(i)) {
                int face = source.nextFace();
                if (face < 1 || face > 6) {
                    throw new IllegalArgumentException("invalid server RNG value");
                }
                next.set(i, face);
            }
        }
        return transitioned(players, Phase.ACTIVE, currentPlayer,
            completedTurns, rolls + 1, next, held);
    }

    /** Set the complete five-die hold mask; only after rolls 1 and 2. */
    public YachtMatchState setHeld(List<Boolean> mask) {
        requireActive();
        if (rolls == 0 || rolls == 3) {
            throw new IllegalStateException("cannot change holds before first/after final roll");
        }
        if (mask == null || mask.size() != 5) {
            throw new IllegalArgumentException("five hold flags required");
        }
        // Java's immutable List.of() throws NPE on contains(null). Do not
        // use contains(null) as a validation predicate for caller lists.
        for (Boolean heldFlag : mask) {
            if (heldFlag == null) {
                throw new IllegalArgumentException("null hold flag");
            }
        }
        return transitioned(players, Phase.ACTIVE, currentPlayer,
            completedTurns, rolls, dice, mask);
    }

    /** Close any nonclosed match, retaining committed scores and event history. */
    public YachtMatchState close() {
        if (phase == Phase.CLOSED) throw new IllegalStateException("match already closed");
        return transitioned(players, Phase.CLOSED, currentPlayer,
            completedTurns, 0, EMPTY_DICE, NO_HOLD);
    }

    public YachtScoring.Choices availableScores() {
        if (rolls == 0 || phase != Phase.ACTIVE) {
            throw new IllegalStateException("no active scored dice");
        }
        return YachtScoring.choices(activePlayer().sheet(), diceArray());
    }

    public YachtMatchState commitScore(Category category) {
        requireActive();
        if (rolls == 0) throw new IllegalStateException("roll before scoring");
        Sheet committed = YachtScoring.commit(activePlayer().sheet(), diceArray(), category);
        var next = new java.util.ArrayList<>(players);
        Player previous = activePlayer();
        next.set(currentPlayer, new Player(previous.id(), previous.displayName(), committed));
        int after = completedTurns + 1;
        Phase nextPhase = after == players.size() * 13
            ? Phase.FINISHED : Phase.ACTIVE;
        return transitioned(next, nextPhase, after % players.size(),
            after, 0, EMPTY_DICE, NO_HOLD);
    }

    private int[] diceArray() {
        return new int[] {dice.get(0), dice.get(1), dice.get(2),
            dice.get(3), dice.get(4)};
    }

    private void requireActive() {
        if (phase != Phase.ACTIVE) {
            throw new IllegalStateException("Yacht match is not active");
        }
    }

    private YachtMatchState transitioned(
        List<Player> nextPlayers, Phase nextPhase, int nextPlayer, int turns,
        int rollCount, List<Integer> nextDice, List<Boolean> nextHeld
    ) {
        return new YachtMatchState(id, name, nextPlayers, nextPhase,
            nextPlayer, turns, rollCount, nextDice, nextHeld, version + 1);
    }
}
