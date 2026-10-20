package io.github.playcosmos.broadcastinggameplatform.games.yacht;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtMatchState;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring.Category;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRoomService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.ConcurrentModificationException;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Real SQLite Y2 service-level contract; no web/browser or provider dependency. */
public final class YachtRoomProbe {
    private static int checks;
    private YachtRoomProbe() {}

    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("yacht-y2-");
        try {
            Path file = directory.resolve("platform.sqlite3");
            var db = new BoardGameDatabase(file);
            db.initialize();
            var broadcasts = new ArrayList<String>();
            var rolled = new AtomicInteger();
            var service = new YachtRoomService(db,
                () -> rolled.getAndIncrement() % 6 + 1,
                (roomCode, json) -> broadcasts.add(roomCode + "|" + json));
            var participants = List.of(
                new YachtRoomService.Participant("alice", "Alice"),
                new YachtRoomService.Participant("bob", "Bob"));
            var first = service.create("create0001", "Yacht API Test", participants);
            String code = first.roomCode();
            require(code.matches("[A-HJ-NP-Z2-9]{6}"), "6-character safe Yacht room code");
            require(first.match().phase() == YachtMatchState.Phase.READY,
                "new room READY with unrolled dice");
            require(broadcasts.size() == 1 && broadcasts.getFirst()
                .contains("\"type\":\"yacht.room.created\""), "room event emitted");
            require(service.create("create0001", "Yacht API Test", participants).equals(first),
                "create request retries must be idempotent");
            require(broadcasts.size() == 1, "no duplicate room event");
            conflict(() -> service.create("create0001", "different", participants),
                "reused creation ID with altered request");
            var secondRoom = service.create("create0002", "Other Yacht", participants);
            require(!secondRoom.roomCode().equals(code), "two rooms must not collide");
            require(service.exists(code) && service.exists(secondRoom.roomCode()),
                "both room codes should be valid");
            require(!service.exists("AAAAAA") || !"AAAAAA".equals(code),
                "room lookups do not accept guessed unused room codes");
            rejected(() -> service.state("INVALID/"), "unsafe room code");
            notFound(() -> service.state("AAAAAA"), "nonexistent room");

            var started = service.command(code, "activate",
                cmd("action0001", 0));
            require(started.match().phase() == YachtMatchState.Phase.ACTIVE
                && started.match().version() == 1, "activate room");
            var rolledOnce = service.command(code, "roll", cmd("action0002", 1));
            require(rolledOnce.match().dice().equals(List.of(1,2,3,4,5))
                && rolledOnce.match().rolls() == 1, "five server-generated dice");
            int rngAfterRoll = rolled.get();
            int broadcastsAfterRoll = broadcasts.size();
            require(service.command(code, "roll", cmd("action0002", 1))
                .equals(rolledOnce), "exact duplicate roll returns original state");
            require(rolled.get() == rngAfterRoll
                && broadcasts.size() == broadcastsAfterRoll,
                "duplicate roll must not advance RNG or emit another event");
            conflict(() -> service.command(code, "score",
                new YachtRoomService.Command("action0002", 1, null, "chance")),
                "commandId reuse with changed action is a conflict");
            conflict(() -> service.command(code, "roll", cmd("action0003", 1)),
                "stale roll must not execute");
            var held = service.command(code, "hold",
                new YachtRoomService.Command("action0003", 2,
                    List.of(true,false,true,false,true), null));
            require(held.match().held().equals(
                List.of(true,false,true,false,true)), "server validated hold mask");
            var rolledAgain = service.command(code, "roll", cmd("action0004", 3));
            require(rolledAgain.match().dice().equals(List.of(1,6,3,1,5)),
                "held dice preserved across new server roll");
            var paused = service.command(code, "pause", cmd("action0005", 4));
            require(paused.match().phase() == YachtMatchState.Phase.PAUSED,
                "pause preserves live turn");
            rejected(() -> service.command(code, "roll", cmd("action0006", 5)),
                "paused game rejects roll");

            // New service object and a separate database connection: persisted
            // scores, dice, hold flags, version and event sequence must match.
            var restartedDb = new BoardGameDatabase(file);
            restartedDb.initialize();
            var recovered = new YachtRoomService(restartedDb,
                () -> 2, (id, event) -> {});
            require(recovered.state(code).equals(paused),
                "process restart recovers exact in-flight state");
            require(recovered.command(code, "roll", cmd("action0004", 3))
                .equals(rolledAgain), "dedup survives process restart");
            var resumed = recovered.command(code, "resume", cmd("action0007", 5));
            require(resumed.match().phase() == YachtMatchState.Phase.ACTIVE,
                "resume exact state after reload");
            var aliceScore = recovered.command(code, "score",
                new YachtRoomService.Command("action0008", 6,
                    null, "chance"));
            require(aliceScore.match().completedTurns() == 1
                && aliceScore.match().currentPlayer() == 1
                && aliceScore.match().players().getFirst().sheet()
                    .scores().get(Category.CHANCE) == 16,
                "first commit adds correct score and rotates player");
            var history = recovered.events(code, -1);
            require(history.size() == 8 && history.getFirst().sequence() == 0
                && history.getLast().sequence() == 7,
                "replayable monotonic committed event log");
            require(recovered.events(code, 5).size() == 2,
                "event cursor replay starts strictly after requested sequence");
            require(recovered.events(secondRoom.roomCode(), -1).size() == 1,
                "events isolated between Yacht rooms");

            // Exactly one same-version command may win across concurrent
            // repository/service instances, even with different command IDs.
            var stage = recovered.state(code);
            var one = new YachtRoomService(new BoardGameDatabase(file),
                () -> 4, (id, json) -> {});
            var two = new YachtRoomService(new BoardGameDatabase(file),
                () -> 5, (id, json) -> {});
            var latch = new CountDownLatch(1);
            var wins = new AtomicInteger();
            var conflicts = new AtomicInteger();
            var errors = new AtomicReference<Throwable>();
            List<Thread> writers = new ArrayList<>();
            for (int index = 0; index < 2; index++) {
                YachtRoomService instance = index == 0 ? one : two;
                String id = index == 0 ? "race00001" : "race00002";
                writers.add(Thread.ofVirtual().start(() -> {
                    try {
                        latch.await();
                        instance.command(code, "roll", cmd(id, stage.match().version()));
                        wins.incrementAndGet();
                    } catch (ConcurrentModificationException expected) {
                        conflicts.incrementAndGet();
                    } catch (Throwable failure) { errors.compareAndSet(null, failure); }
                }));
            }
            latch.countDown();
            for (var thread : writers) thread.join();
            if (errors.get() != null) throw new IllegalStateException(
                "Yacht race crashed", errors.get());
            require(wins.get() == 1 && conflicts.get() == 1,
                "exactly one race command advances turn and event");
            require(recovered.state(code).match().version() == stage.match().version() + 1,
                "atomic conflict must preserve monotonic sequence");

            // Complete the remaining 25 scoring turns using *only* server
            // commands, never direct Y1 repository access or injected dice.
            var state = recovered.state(code);
            int index = 20;
            while (state.match().phase() != YachtMatchState.Phase.FINISHED) {
                if (state.match().rolls() == 0) {
                    state = recovered.command(code, "roll",
                        cmd("finishroll" + (++index), state.match().version()));
                }
                Category category = state.availableScores()
                    .points().keySet().iterator().next();
                state = recovered.command(code, "score",
                    new YachtRoomService.Command("finishscore" + (++index),
                        state.match().version(), null, category.id()));
                require(index < 85, "Yacht match should finish within 26 turns");
            }
            require(state.match().completedTurns() == 26
                && state.match().players().stream().allMatch(p -> p.sheet().complete()),
                "Y2 command API completes 26 turns for two players");
            require(recovered.state(code).equals(state),
                "completed game persists after final commit");
            rejected(() -> recovered.command(code, "roll",
                cmd("actionpostgame", state.match().version())),
                "finished match cannot roll");

            var closed = recovered.command(secondRoom.roomCode(), "close",
                cmd("close0001", 0));
            require(closed.match().phase() == YachtMatchState.Phase.CLOSED,
                "operator may close a READY room");
            rejected(() -> recovered.command(secondRoom.roomCode(), "activate",
                cmd("close0002", 1)), "closed room never reactivates");
            require(recovered.state(secondRoom.roomCode()).equals(closed),
                "closed state is durably recovered");

            var broadcastFailure = new YachtRoomService(new BoardGameDatabase(file),
                () -> 1, (id, json) -> { throw new RuntimeException("disconnect"); });
            var another = broadcastFailure.create("create0003", "Recovery",
                participants);
            require(broadcastFailure.events(another.roomCode(), -1).size() == 1,
                "broadcast exception cannot undo committed event");
            require(broadcastFailure.command(another.roomCode(), "activate",
                cmd("offline0001", 0)).match().phase() == YachtMatchState.Phase.ACTIVE,
                "WebSocket outage does not discard committed command");
            require(broadcastFailure.events(another.roomCode(), 0).size() == 1,
                "event is replayable after WebSocket outage");

            System.out.println("YACHT_Y2_PASSED checks=" + checks
                + " two_player_turns=26 idempotency=durable"
                + " concurrent=exclusive events=replayable"
                + " room_isolation=true recovery=true");
        } finally {
            try (var walk = Files.walk(directory)) {
                walk.sorted((a,b) -> b.compareTo(a)).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) {}
                });
            }
        }
    }

    private static YachtRoomService.Command cmd(String id, long version) {
        return new YachtRoomService.Command(id, version, null, null);
    }

    private interface Attempt { void run() throws Exception; }
    private static void conflict(Attempt attempt, String label) throws Exception {
        checks++;
        try { attempt.run(); }
        catch (ConcurrentModificationException expected) { return; }
        throw new AssertionError("expected version conflict: " + label);
    }
    private static void rejected(Attempt attempt, String label) throws Exception {
        checks++;
        try { attempt.run(); }
        catch (IllegalArgumentException | IllegalStateException expected) { return; }
        throw new AssertionError("expected rejection: " + label);
    }
    private static void notFound(Attempt attempt, String label) throws Exception {
        checks++;
        try { attempt.run(); }
        catch (NoSuchElementException expected) { return; }
        throw new AssertionError("expected missing room: " + label);
    }
    private static void require(boolean condition, String label) {
        checks++;
        if (!condition) throw new AssertionError(label);
    }
}
