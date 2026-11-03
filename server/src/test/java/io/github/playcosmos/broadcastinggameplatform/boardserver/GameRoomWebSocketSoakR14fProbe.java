package io.github.playcosmos.broadcastinggameplatform.boardserver;

import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomRealtimeService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.lang.management.ManagementFactory;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * R14f: actual localhost member WebSocket fan-out, abrupt disconnect,
 * durable cursor replay, session revocation and transport shutdown.
 *
 * Ten spectators per wave stays below the documented per-remote socket
 * limit (24); four waves + two negative connections stay below 120
 * handshakes per 10s. This is a bounded deterministic acceptance, not
 * a maximum-load or WAN benchmark.
 */
public final class GameRoomWebSocketSoakR14fProbe {
    private static int checks;
    private static final int SPECTATORS = 10;
    private GameRoomWebSocketSoakR14fProbe() {}

    private static final class Observer implements WebSocket.Listener {
        final LinkedBlockingQueue<String> messages = new LinkedBlockingQueue<>();
        final AtomicInteger closed = new AtomicInteger(-1);
        private final StringBuilder pending = new StringBuilder();
        @Override public void onOpen(WebSocket socket) { socket.request(1); }
        @Override public CompletionStage<?> onText(
            WebSocket socket,CharSequence text,boolean last) {
            pending.append(text);
            if(last) {
                messages.offer(pending.toString());
                pending.setLength(0);
            }
            socket.request(1);
            return null;
        }
        @Override public CompletionStage<?> onClose(
            WebSocket socket,int status,String reason) {
            closed.set(status);
            return CompletableFuture.completedFuture(null);
        }
        @Override public void onError(WebSocket socket,Throwable error) {
            closed.set(1011);
        }
        String await(String marker,String context) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(12);
            while (System.nanoTime() < deadline) {
                var frame = messages.poll(200,TimeUnit.MILLISECONDS);
                if(frame != null && frame.contains(marker)) return frame;
                if(closed.get() >= 0)
                    throw new AssertionError(context + " unexpected close=" + closed.get());
            }
            throw new AssertionError(context + " websocket timeout: " + marker);
        }
        void expectRevoked(String context) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
            while(System.nanoTime() < deadline) {
                if(closed.get()==1008) return;
                if(closed.get()>0)
                    throw new AssertionError(context + " close=" + closed.get());
                Thread.sleep(50);
            }
            throw new AssertionError(context + " did not revoke socket");
        }
    }

    private record Client(WebSocket socket,Observer observer) {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("room-r14f-websocket-");
        BoardGameWebSocketServer websocket = null;
        var sockets = new ArrayList<WebSocket>();
        int port = freePort();
        int beforeThreads = ManagementFactory.getThreadMXBean().getThreadCount();
        long beforeHeap = heapUsed();
        try {
            Path dbFile = root.resolve("game.sqlite");
            var database = new BoardGameDatabase(dbFile);
            database.initialize();
            var access = new GameRoomAccessService(database);
            var holder = new AtomicReference<BoardGameWebSocketServer>();
            var realtime = new GameRoomRealtimeService(database,access,(id,json)->{
                var ws=holder.get();
                if(ws!=null)ws.broadcastRoomEvent(id,json);
            });
            websocket = new BoardGameWebSocketServer("127.0.0.1",port,
                code->false,null,code->false,access,realtime);
            holder.set(websocket);
            websocket.start();

            try(var http = HttpClient.newHttpClient()) {
                for(String game : List.of("drawing_guess","yacht")) {
                    exerciseGame(game,access,realtime,http,port,sockets);
                }
            }
            // Clean up every client and prove the real WebSocket listener
            // relinquishes its port before claiming shutdown success.
            for(var socket:sockets) try {socket.abort();}
                catch(RuntimeException ignored) {}
            websocket.stop(2500);
            websocket=null;
            waitForPortRelease(port);
            verify(true,"WebSocket listener port reusable after graceful stop");

            int afterThreads=ManagementFactory.getThreadMXBean().getThreadCount();
            long afterHeap=heapUsed();
            System.out.println("GAME_ROOM_R14F_WEBSOCKET_SOAK_PASSED checks="
                + checks + " games=2 spectatorsPerGame=" + SPECTATORS
                + " waves=2 roomMessages=6"
                + " threadBefore=" + beforeThreads + " threadAfter=" + afterThreads
                + " heapBeforeBytes=" + beforeHeap + " heapAfterBytes=" + afterHeap);
        } finally {
            for(var socket:sockets) try {socket.abort();}
                catch(RuntimeException ignored) {}
            if(websocket!=null) {
                try {websocket.stop(2500);}
                catch(InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            try(var paths=Files.walk(root)) {
                paths.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try {Files.deleteIfExists(p);}
                    catch(Exception ignored) {}
                });
            }
        }
    }

    private static void exerciseGame(String game,GameRoomAccessService access,
        GameRoomRealtimeService realtime,HttpClient http,int port,
        List<WebSocket> allSockets) throws Exception {
        var hosted=access.createPublicHostedRoom(game,"R14f "+game,
            "host",SeatRole.PLAYER,2,20);
        String host=hosted.hostCredential().token();
        String roomId=hosted.room().roomId();
        URI uri=URI.create("ws://127.0.0.1:"+port+"/?memberRoomId="+roomId);
        var tokens=new ArrayList<GameRoomAccessService.Credential>();
        for(int i=0;i<SPECTATORS;i++) {
            tokens.add(access.joinPublic(game,hosted.room().roomCode(),
                "viewer-"+i,SeatRole.SPECTATOR));
        }
        verify(access.room(host).memberCount()==SPECTATORS+1
            && access.room(host).playerCount()==1,
            game+" spectator connection does not consume player seats");

        var viewers = new ArrayList<Client>();
        for(var token:tokens) {
            Client client=connect(http,uri,token.token(),-1);
            viewers.add(client);allSockets.add(client.socket());
            String snapshot=client.observer().await("\"type\":\"room.snapshot\"",
                game+" member initial snapshot");
            verify(snapshot.contains("\"memberCount\":"+(SPECTATORS+1))
                && snapshot.contains("\"playerCount\":1"),
                game+" correct authenticated WS snapshot");
        }
        String first="r14f-"+game+"-first";
        realtime.chat(host,first,"First live fanout");
        for(var viewer:viewers) {
            verify(viewer.observer().await(first,game+" first live event")
                .contains("\"sequence\":1"),
                game+" spectator receives committed first event");
        }

        // Abrupt network/client loss, not voluntary leave: the durable
        // member token and past cursor remain valid.
        for(var viewer:viewers) viewer.socket().abort();
        viewers.clear();
        String missed="r14f-"+game+"-missed";
        realtime.chat(host,missed,"Offline durable delivery");
        verify(realtime.lastSequence(host)==2,
            game+" missed socket broadcast cannot lose event sequence");

        // Re-subscribing with cursor 1 must replay sequence 2 exactly
        // once on a new WebSocket, followed by live sequence 3.
        for(var token:tokens) {
            Client client=connect(http,uri,token.token(),1);
            viewers.add(client);allSockets.add(client.socket());
            client.observer().await("\"type\":\"room.snapshot\"",
                game+" reconnect snapshot");
            String replay=client.observer().await(missed,
                game+" durable cursor replay");
            verify(replay.contains("\"sequence\":2"),
                game+" replay preserves committed event sequence");
        }
        String third="r14f-"+game+"-third";
        realtime.chat(host,third,"Live after reconnect");
        for(var viewer:viewers) {
            verify(viewer.observer().await(third,game+" post-reconnect event")
                .contains("\"sequence\":3"),
                game+" resumed stream receives live updates");
        }
        verify(realtime.lastSequence(host)==3,
            game+" no duplicate sequences during reconnect");

        var revoked=viewers.get(0);
        access.kick(host,tokens.get(0).memberId());
        revoked.observer().expectRevoked(game+" kicked member");
        verify(true,game+" server closes kicked spectator with 1008");
        Client denied=connect(http,uri,tokens.get(0).token(),-1);
        allSockets.add(denied.socket());
        denied.observer().expectRevoked(game+" old bearer re-subscription");
        verify(true,game+" revoked bearer cannot re-subscribe");
        access.closeRoom(host);
        for(int i=1;i<viewers.size();i++) {
            viewers.get(i).observer().expectRevoked(game+" room closed");
        }
        verify(true,game+" room-close revokes and closes remaining spectators");
    }

    private static Client connect(HttpClient http,URI uri,String token,
        long cursor) throws Exception {
        var observer=new Observer();
        Exception last=null;
        WebSocket socket=null;
        for(int attempt=0;attempt<25;attempt++) {
            try {
                socket=http.newWebSocketBuilder().buildAsync(uri,observer)
                    .get(3,TimeUnit.SECONDS);
                break;
            } catch(Exception error) {
                last=error;
                Thread.sleep(75);
            }
        }
        if(socket==null)throw new AssertionError("WebSocket connect failed",last);
        socket.sendText("{\"type\":\"room.subscribe\",\"token\":\""+token
            +"\",\"afterSequence\":"+cursor+"}",true)
            .get(3,TimeUnit.SECONDS);
        return new Client(socket,observer);
    }

    private static void waitForPortRelease(int port) throws Exception {
        Exception last=null;
        for(int attempt=0;attempt<25;attempt++) {
            try(var socket=new ServerSocket()) {
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress("127.0.0.1",port));
                return;
            }catch(Exception error) {
                last=error;
                Thread.sleep(100);
            }
        }
        throw new AssertionError("WebSocket server left TCP port bound",last);
    }
    private static int freePort() throws Exception {
        try(var socket=new ServerSocket(0)) {return socket.getLocalPort();}
    }
    private static long heapUsed() {
        var rt=Runtime.getRuntime();
        return rt.totalMemory()-rt.freeMemory();
    }
    private static void verify(boolean condition,String message) {
        if(!condition)throw new AssertionError("R14f: "+message);
        checks++;
    }
}
