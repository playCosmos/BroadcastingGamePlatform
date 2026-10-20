package io.github.playcosmos.broadcastinggameplatform.games.yacht;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtMatchState;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring.Category;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.ConcurrentModificationException;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Y1 end-to-end persistence validation using a real SQLite DB opened/reopened
 * across distinct JDBC connections, not in-memory fake storage.
 */
public final class YachtPersistenceProbe {
    private static int checks;
    private YachtPersistenceProbe() {}

    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("yacht-y1-");
        try {
            Path file = directory.resolve("platform.sqlite3");
            var db = new BoardGameDatabase(file);
            db.initialize(); // Real V29 migration, without altering Board tables
            var repo = new YachtRepository(db);
            var players = List.of(
                new YachtMatchState.Player("alice", "Alice", YachtScoring.Sheet.empty()),
                new YachtMatchState.Player("bob", "Bob", YachtScoring.Sheet.empty()));
            var match = repo.create("Deterministic Yacht", players);
            require(match.phase() == YachtMatchState.Phase.READY && match.version() == 0,
                "new match READY");
            require(repo.find(match.id()).equals(match), "initial snapshot recovery");
            rejected(() -> match.roll(() -> 2), "cannot roll before match starts");
            rejected(() -> match.setHeld(List.of(true,true,true,true,true)),
                "cannot hold before match starts");
            rejected(() -> match.commitScore(Category.CHANCE),
                "cannot score before match starts");

            match = repo.apply(match.id(), YachtMatchState::start);
            require(match.phase() == YachtMatchState.Phase.ACTIVE && match.version() == 1,
                "match transitioned to ACTIVE");
            var started = match;
            rejected(() -> started.setHeld(List.of(false,false,false,false,false)),
                "hold blocked before first roll");
            match = repo.apply(match.id(), state -> state.roll(
                new SequenceDice(1,2,3,4,5)));
            require(match.rolls() == 1
                && match.dice().equals(List.of(1,2,3,4,5)), "deterministic first roll");

            match = repo.apply(match.id(), state -> state.setHeld(
                List.of(true,false,true,false,true)));
            var held = match;
            require(held.held().equals(List.of(true,false,true,false,true)),
                "hold mask committed");
            rejected(() -> held.held().set(0, false), "held list must be immutable");
            rejected(() -> held.dice().set(0, 6), "dice must be immutable");
            rejected(() -> held.players().clear(), "player list must be immutable");

            match = repo.apply(match.id(), state -> state.roll(
                new SequenceDice(6,6)));
            require(match.dice().equals(List.of(1,6,3,6,5)) && match.rolls() == 2,
                "only unheld dice rerolled; held values preserved");
            match = repo.apply(match.id(), YachtMatchState::pause);
            var paused = match;
            rejected(() -> paused.roll(() -> 1), "paused match cannot roll");
            rejected(() -> paused.setHeld(List.of(false,false,false,false,false)),
                "paused match cannot change holds");
            rejected(() -> paused.commitScore(Category.CHANCE),
                "paused match cannot score");

            // Re-open the database using a separate server-style instance.
            var dbRestarted = new BoardGameDatabase(file);
            dbRestarted.initialize();
            var resumedRepo = new YachtRepository(dbRestarted);
            require(resumedRepo.find(match.id()).equals(match),
                "pause/roll/hold and participant scoring must survive restart");
            match = resumedRepo.apply(match.id(), YachtMatchState::resume);
            match = resumedRepo.apply(match.id(), state -> state.roll(
                new SequenceDice(4,2)));
            require(match.rolls() == 3
                && match.dice().equals(List.of(1,4,3,2,5)),
                "third roll after restart maintains held dice");
            var finalRoll = match;
            rejected(() -> finalRoll.roll(() -> 1), "max 3 rolls");
            rejected(() -> finalRoll.setHeld(List.of(false,false,false,false,false)),
                "hold blocked after third roll");

            var options = finalRoll.availableScores();
            require(options.points().get(Category.LARGE_STRAIGHT) == 40,
                "authoritative options based on actual third roll");
            match = resumedRepo.apply(match.id(),
                state -> state.commitScore(Category.LARGE_STRAIGHT));
            require(match.currentPlayer() == 1 && match.completedTurns() == 1
                && match.rolls() == 0
                && match.dice().equals(YachtMatchState.emptyDice())
                && match.players().get(0).sheet().scores()
                    .get(Category.LARGE_STRAIGHT) == 40,
                "scoring resets next-player turn without losing old sheet");

            // Stale, concurrent commands must not advance the same turn twice.
            var previouslyLoaded = resumedRepo.find(match.id());
            var next = previouslyLoaded.roll(() -> 1);
            resumedRepo.update(next, previouslyLoaded.version());
            boolean stale = false;
            try { repo.update(previouslyLoaded.roll(() -> 6), previouslyLoaded.version()); }
            catch (ConcurrentModificationException expected) { stale = true; }
            require(stale, "stale optimistic version must be rejected");
            require(resumedRepo.find(match.id()).equals(next),
                "stale mutation must never overwrite committed roll");

            // Same-version racing writers, two separate repository instances.
            var beforeRace = resumedRepo.find(match.id());
            var gate = new CountDownLatch(1);
            var winner = new AtomicInteger();
            var conflict = new AtomicInteger();
            var errors = new java.util.concurrent.atomic.AtomicReference<Throwable>();
            List<Thread> threads = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                int seed = i + 2;
                var writer = new YachtRepository(new BoardGameDatabase(file));
                threads.add(Thread.ofVirtual().start(() -> {
                    try {
                        gate.await();
                        writer.update(beforeRace.roll(() -> seed), beforeRace.version());
                        winner.incrementAndGet();
                    } catch (ConcurrentModificationException expected) {
                        conflict.incrementAndGet();
                    } catch (Throwable exception) { errors.compareAndSet(null, exception); }
                }));
            }
            gate.countDown();
            for (var thread : threads) thread.join();
            if (errors.get() != null) throw new IllegalStateException(
                "concurrent repository update failed", errors.get());
            require(winner.get() == 1 && conflict.get() == 1,
                "racing writer must produce exactly one committed change");
            match = resumedRepo.find(match.id());
            require(match.rolls() == 2, "race advanced exactly one roll");

            // No scoring twice in the same turn or reusing a category.
            match = resumedRepo.apply(match.id(),
                state -> state.commitScore(Category.CHANCE));
            require(match.currentPlayer() == 0 && match.completedTurns() == 2,
                "roll-and-score advances to next player");
            var afterScore = match;
            rejected(() -> afterScore.commitScore(Category.CHANCE),
                "score requires new first roll");
            var reread = resumedRepo.find(match.id());
            require(reread.equals(match), "continued match round-trips after restart");

            // All 26 scoring turns must finish precisely at 13 per player.
            // The two initial committed categories differ, so prefer a legal
            // unfilled category each turn, including mandatory Joker overrides.
            int commands = 0;
            while (!match.phase().equals(YachtMatchState.Phase.FINISHED)) {
                match = resumedRepo.apply(match.id(), state -> state.roll(() -> 1));
                var chosen = match.availableScores().points().keySet().iterator().next();
                match = resumedRepo.apply(match.id(), state -> state.commitScore(chosen));
                commands += 2;
                if (commands > 60) throw new AssertionError("match did not terminate");
            }
            require(match.completedTurns() == 26 && match.version() > 26,
                "all 13 turns per player complete");
            require(match.players().stream().allMatch(p -> p.sheet().complete()),
                "both immutable scorecards contain 13 distinct categories");
            require(resumedRepo.find(match.id()).equals(match),
                "complete match survives clean reopen");
            var completed = match;
            rejected(() -> completed.roll(() -> 1), "finished match cannot roll");
            rejected(() -> completed.pause(), "finished match cannot pause");
            rejected(() -> completed.commitScore(Category.YACHT),
                "finished match cannot score");

            // Corrupt persistence is fail-closed, never silently reconstructs
            // fabricated dice/bonuses from partial or unknown schema.
            try (var connection = dbRestarted.open();
                 var statement = connection.prepareStatement(
                    "UPDATE yacht_match SET state_json=? WHERE match_id=?")) {
                statement.setString(1, "{\"schema\":999}");
                statement.setString(2, match.id());
                statement.executeUpdate();
            }
            boolean corruptedRejected = false;
            try { resumedRepo.find(match.id()); }
            catch (IllegalStateException expected) { corruptedRejected = true; }
            require(corruptedRejected, "corrupted snapshot must not recover silently");

            System.out.println("YACHT_Y1_PASSED checks=" + checks
                + " completed_turns=26 players=2 restart=parity"
                + " concurrency=cas-exclusive pause=restored"
                + " roll_limit=3 immutable=true corrupted=fail-closed");
        } finally {
            try (var files = Files.walk(directory)) {
                files.sorted((a,b) -> b.compareTo(a)).forEach(path -> {
                    try { Files.deleteIfExists(path); }
                    catch (Exception ignored) {}
                });
            }
        }
    }

    private static final class SequenceDice implements YachtMatchState.DiceRandomSource {
        private final int[] faces;
        private int index;
        SequenceDice(int... faces) { this.faces = Arrays.copyOf(faces, faces.length); }
        @Override public int nextFace() {
            if (index >= faces.length) {
                throw new IllegalStateException("deterministic RNG exhausted");
            }
            return faces[index++];
        }
    }

    private static void require(boolean condition, String label) {
        checks++;
        if (!condition) throw new AssertionError(label);
    }
    private static void rejected(Runnable action, String label) {
        checks++;
        try { action.run(); }
        catch (IllegalStateException | IllegalArgumentException
               | UnsupportedOperationException expected) { return; }
        throw new AssertionError("expected rejection: " + label);
    }
}
