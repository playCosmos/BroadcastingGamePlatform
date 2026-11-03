package io.github.playcosmos.broadcastinggameplatform.boardserver;

import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRoomService;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Real WebSocket transport isolation: Yacht is read-only and room scoped. */
public final class YachtWebSocketProbe {
    private YachtWebSocketProbe() {}

    private static final class Observer implements WebSocket.Listener {
        private final LinkedBlockingQueue<String> messages = new LinkedBlockingQueue<>();
        private final CountDownLatch closed = new CountDownLatch(1);
        private final AtomicInteger closeCode = new AtomicInteger(-1);
        private final StringBuilder partial = new StringBuilder();

        @Override public void onOpen(WebSocket socket) { socket.request(1); }
        @Override public CompletionStage<?> onText(
            WebSocket socket, CharSequence data, boolean last
        ) {
            partial.append(data);
            if (last) {
                messages.offer(partial.toString());
                partial.setLength(0);
            }
            socket.request(1);
            return null;
        }
        @Override public CompletionStage<?> onClose(
            WebSocket socket, int code, String reason
        ) {
            closeCode.set(code);
            closed.countDown();
            return CompletableFuture.completedFuture(null);
        }
        @Override public void onError(WebSocket socket, Throwable error) {
            closed.countDown();
        }
        String next() throws Exception { return messages.poll(3, TimeUnit.SECONDS); }
        boolean hasNoMessage() throws Exception {
            return messages.poll(350, TimeUnit.MILLISECONDS) == null;
        }
        boolean closedPolicy() throws Exception {
            return closed.await(3, TimeUnit.SECONDS) && closeCode.get() == 1008;
        }
    }

    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("yacht-websocket-");
        BoardGameWebSocketServer server = null;
        WebSocket yachtA = null, yachtB = null, boardA = null, invalid = null;
        try {
            var db = new BoardGameDatabase(directory.resolve("game.sqlite"));
            db.initialize();
            var serverReference = new AtomicReference<BoardGameWebSocketServer>();
            var yacht = new YachtRoomService(db, (roomCode, json) -> {
                var live = serverReference.get();
                if (live != null) live.broadcastYacht(roomCode, json);
            });
            var players = List.of(
                new YachtRoomService.Participant("p1", "A"),
                new YachtRoomService.Participant("p2", "B"));
            String first = yacht.create("socket-room-one", "First", players).roomCode();
            String second = yacht.create("socket-room-two", "Second", players).roomCode();
            int port;
            try (var socket = new ServerSocket(0)) { port = socket.getLocalPort(); }
            server = new BoardGameWebSocketServer("127.0.0.1", port,
                code -> code.equals(first), null, yacht::exists);
            serverReference.set(server);
            server.start();

            var client = HttpClient.newHttpClient();
            var yachtObserverA = new Observer();
            var yachtObserverB = new Observer();
            var boardObserver = new Observer();
            yachtA = connect(client, port, "yachtCode=" + first, yachtObserverA);
            yachtB = connect(client, port, "yachtCode=" + second, yachtObserverB);
            boardA = connect(client, port, "roomCode=" + first, boardObserver);

            var activated = yacht.command(first, "activate",
                new YachtRoomService.Command("socket-command-01", 0, null, null));
            require(activated.match().version() == 1, "activated Yacht first room");
            String notification = yachtObserverA.next();
            require(notification != null
                && notification.contains("\"roomCode\":\""+first+"\"")
                && notification.contains("\"sequence\":1")
                && notification.contains("\"gameId\":\"yacht\""),
                "Yacht subscriber must see its own committed sequence event");
            require(yachtObserverB.hasNoMessage(),
                "separate Yacht room must not receive A event");
            require(boardObserver.hasNoMessage(),
                "Board subscriber sharing same code must not receive Yacht event");

            yachtA.sendText("{\"type\":\"roll\"}", true).get(3, TimeUnit.SECONDS);
            require(yachtObserverA.closedPolicy(),
                "attempted client-side Yacht mutation must close socket with 1008");
            require(yacht.state(first).match().version() == 1,
                "WebSocket mutation attempt must not change Yacht room");

            var invalidObserver = new Observer();
            invalid = connect(client, port, "yachtCode=INVALID", invalidObserver);
            require(invalidObserver.closedPolicy(),
                "invalid Yacht room code WebSocket must be closed");
            require(yacht.events(first, -1).size() == 2,
                "HTTP replay retains committed creation+activation events");

            System.out.println("YACHT_WS_Y2_PASSED isolation=yacht-board"
                + " room_code=validated websocket=read-only"
                + " reconnect=events-retained");
        } finally {
            for (WebSocket socket : new WebSocket[]{yachtA, yachtB, boardA, invalid}) {
                if (socket != null) {
                    try { socket.abort(); } catch (RuntimeException ignored) {}
                }
            }
            if (server != null) {
                try { server.stop(1500); }
                catch (InterruptedException stop) { Thread.currentThread().interrupt(); }
            }
            try (var files = Files.walk(directory)) {
                files.sorted((a,b)->b.compareTo(a)).forEach(file -> {
                    try { Files.deleteIfExists(file); } catch (Exception ignored) {}
                });
            }
        }
    }

    private static WebSocket connect(
        HttpClient client, int port, String query, Observer observer
    ) throws Exception {
        URI uri = URI.create("ws://127.0.0.1:" + port + "/?" + query);
        Exception last = null;
        for (int attempt = 0; attempt < 20; attempt++) {
            try {
                return client.newWebSocketBuilder().buildAsync(uri, observer)
                    .get(2, TimeUnit.SECONDS);
            } catch (Exception failed) {
                last = failed;
                Thread.sleep(100);
            }
        }
        throw new IllegalStateException("Yacht WebSocket did not start", last);
    }

    private static void require(boolean correct, String detail) {
        if (!correct) throw new AssertionError(detail);
    }
}
