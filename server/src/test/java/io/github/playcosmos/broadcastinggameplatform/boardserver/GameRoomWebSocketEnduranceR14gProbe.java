package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonObject;
import java.io.BufferedWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.StandardOpenOption;
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
 * R14g: bounded, repeatable real WebSocket transport endurance across a
 * server restart and SQLite reopen. No external services or personal data.
 *
 * Six spectators per game are connected at once (12 from localhost, under
 * the 24-per-remote cap). Each connection is paced, so extended runs do not
 * trip the production 120-handshakes / 10-seconds anti-abuse threshold.
 *
 * CI: six rounds. Operator opt-in: --rounds=200, etc.
 * This is not a production WAN throughput/latency benchmark.
 */
public final class GameRoomWebSocketEnduranceR14gProbe {
    private static final int SPECTATORS = 6;
    private static final int DEFAULT_ROUNDS = 6;
    private static final int MAX_ROUNDS = 10000;
    private static final int CONNECTION_PAUSE_MILLIS = 145;
    private static int checks;

    private GameRoomWebSocketEnduranceR14gProbe() {}

    private static final class Observer implements WebSocket.Listener {
        final LinkedBlockingQueue<String> messages=new LinkedBlockingQueue<>();
        final AtomicInteger closeCode=new AtomicInteger(-1);
        final StringBuilder pending=new StringBuilder();
        @Override public void onOpen(WebSocket ws) { ws.request(1); }
        @Override public CompletionStage<?> onText(
            WebSocket ws, CharSequence data, boolean last) {
            pending.append(data);
            if(last) {
                messages.add(pending.toString());
                pending.setLength(0);
            }
            ws.request(1);
            return CompletableFuture.completedFuture(null);
        }
        @Override public CompletionStage<?> onClose(
            WebSocket ws,int code,String reason) {
            closeCode.set(code);
            return CompletableFuture.completedFuture(null);
        }
        @Override public void onError(WebSocket ws,Throwable error) {
            closeCode.set(1011);
        }
        String await(String marker,String context) throws Exception {
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(12);
            while(System.nanoTime()<until) {
                var message=messages.poll(200,TimeUnit.MILLISECONDS);
                if(message!=null && message.contains(marker))return message;
                if(closeCode.get()>0)throw new AssertionError(
                    context+" unexpected socket close="+closeCode.get());
            }
            throw new AssertionError(context+" timed out waiting for "+marker);
        }
        void revoked(String context) throws Exception {
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            while(System.nanoTime()<until) {
                if(closeCode.get()==1008)return;
                if(closeCode.get()>0)throw new AssertionError(
                    context+" wrong close code="+closeCode.get());
                Thread.sleep(40);
            }
            throw new AssertionError(context+" missed WebSocket 1008");
        }
    }
    private record Client(WebSocket socket,Observer observer) {}
    private record RoomSession(String game,String host,String roomId,
                               List<GameRoomAccessService.Credential> guests) {}
    private record Services(GameRoomAccessService access,
                            GameRoomRealtimeService events,
                            BoardGameWebSocketServer socket) {}

    public static void main(String[] args) throws Exception {
        int rounds=DEFAULT_ROUNDS;
        Path reportPath=null;
        for(String arg:args) {
            if(arg.startsWith("--rounds=")) {
                rounds=Integer.parseInt(arg.substring("--rounds=".length()));
            } else if(arg.startsWith("--report=")) {
                if(reportPath!=null)throw new IllegalArgumentException("duplicate --report");
                reportPath=Path.of(arg.substring("--report=".length()))
                    .toAbsolutePath().normalize();
            } else throw new IllegalArgumentException(
                "expected --rounds=N or --report=path");
        }
        if(rounds<2||rounds>MAX_ROUNDS)
            throw new IllegalArgumentException("rounds must be 2.."+MAX_ROUNDS);
        Path root=Files.createTempDirectory("r14g-room-endurance-");
        int port=freePort();
        int threadsBefore=ManagementFactory.getThreadMXBean().getThreadCount();
        long heapBefore=usedHeap();
        long started=System.nanoTime();
        Services services=null;
        // CREATE_NEW prevents accidental clobbering of an earlier result.
        // Reports contain aggregate diagnostics only, never room IDs or tokens.
        BufferedWriter report=reportPath==null ? null : Files.newBufferedWriter(
            reportPath,StandardCharsets.UTF_8,
            StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE);
        try(var http=HttpClient.newHttpClient()) {
            if(report!=null) {
                var start=new JsonObject();
                start.addProperty("kind","start");
                start.addProperty("schemaVersion",1);
                start.addProperty("rounds",rounds);
                start.addProperty("spectators",12);
                start.addProperty("games",2);
                start.addProperty("process","isolated-java-fixture");
                appendReport(report,start);
            }
            var database=new BoardGameDatabase(root.resolve("room.sqlite"));
            database.initialize();
            services=start(database,port);
            var rooms=new ArrayList<RoomSession>();
            for(String game:List.of("drawing_guess","yacht")) {
                var hosted=services.access().createPublicHostedRoom(
                    game,"R14g "+game,"host",SeatRole.PLAYER,2,12);
                var guests=new ArrayList<GameRoomAccessService.Credential>();
                for(int i=0;i<SPECTATORS;i++)
                    guests.add(services.access().joinPublic(game,
                        hosted.room().roomCode(),"spectator-"+i,
                        SeatRole.SPECTATOR));
                rooms.add(new RoomSession(game,hosted.hostCredential().token(),
                    hosted.room().roomId(),guests));
                require(services.access().room(hosted.hostCredential().token())
                    .playerCount()==1
                    && services.access().room(hosted.hostCredential().token())
                        .memberCount()==SPECTATORS+1,
                    game+" member capacity/role retained");
            }

            List<List<Client>> sockets=connectAll(http,port,rooms,0,services);
            for(int i=0;i<rooms.size();i++) {
                var room=rooms.get(i);
                String id=messageId(room.game(),"initial",0);
                services.events().chat(room.host(),id,"First live message");
                checkAll(sockets.get(i),id,1,room.game()+" initial fan-out");
            }
            abortAll(sockets);
            awaitCount(services.socket(),0,"before server restart");
            services.socket().stop(2500);
            services=null;
            awaitPortRelease(port);
            require(true,"first server stopped and released TCP listener");

            // A brand-new service layer uses the same persisted SQLite DB.
            // Commit a message with no transport listeners: the next socket
            // subscription must replay it from its durable cursor.
            var reopened=new BoardGameDatabase(database.path());
            reopened.initialize();
            var disconnectedAccess=new GameRoomAccessService(reopened);
            var disconnectedEvents=new GameRoomRealtimeService(reopened,
                disconnectedAccess,(room,json)->{});
            for(var room:rooms) {
                var receipt=disconnectedEvents.chat(room.host(),
                    messageId(room.game(),"offline",0),"Server offline message");
                require(receipt.sequence()==2,
                    room.game()+" persisted a message during transport outage");
            }
            services=start(reopened,port);
            sockets=connectAll(http,port,rooms,1,services);
            for(int i=0;i<rooms.size();i++)
                checkAll(sockets.get(i),
                    messageId(rooms.get(i).game(),"offline",0),2,
                    rooms.get(i).game()+" replay after process-component restart");

            for(int round=1;round<=rounds;round++) {
                long roundStarted=System.nanoTime();
                long liveSeq=round*2L+1;
                long offlineSeq=liveSeq+1;
                for(int i=0;i<rooms.size();i++) {
                    var room=rooms.get(i);
                    String id=messageId(room.game(),"live",round);
                    services.events().chat(room.host(),id,"R14g live "+round);
                    checkAll(sockets.get(i),id,liveSeq,
                        room.game()+" live round "+round);
                }
                abortAll(sockets);
                awaitCount(services.socket(),0,"round "+round+" disconnect");
                for(var room:rooms) {
                    String id=messageId(room.game(),"missed",round);
                    var event=services.events().chat(room.host(),id,
                        "R14g missed "+round);
                    require(event.sequence()==offlineSeq,
                        room.game()+" durable offline cursor round "+round);
                }
                sockets=connectAll(http,port,rooms,liveSeq,services);
                for(int i=0;i<rooms.size();i++)
                    checkAll(sockets.get(i),
                        messageId(rooms.get(i).game(),"missed",round),
                        offlineSeq,
                        rooms.get(i).game()+" replay round "+round);
                if(report!=null)recordRound(report,round,
                    (System.nanoTime()-roundStarted)/1_000_000.0,services.socket());
                if(round==1||round%10==0||round==rounds)
                    System.out.println("[r14g-soak] round="+round+"/"+rounds
                        +" sockets="+services.socket().connectedClients()
                        +" threads="+ManagementFactory.getThreadMXBean()
                            .getThreadCount()
                        +" heapUsedBytes="+usedHeap()
                        +" elapsedMs="+(System.nanoTime()-started)/1_000_000);
            }
            for(int i=0;i<rooms.size();i++) {
                var room=rooms.get(i);
                long last=rounds*2L+2;
                require(services.events().lastSequence(room.host())==last,
                    room.game()+" room sequence remains monotonic after restart");
                require(services.events().events(room.host(),last-1)
                    .events().size()==1,
                    room.game()+" last replay cursor contains one event");
                services.access().kick(room.host(),room.guests().get(0).memberId());
                sockets.get(i).get(0).observer().revoked(
                    room.game()+" kicked spectator");
                require(true,room.game()+" live socket revoked after endurance");
                services.access().closeRoom(room.host());
                sockets.get(i).get(1).observer().revoked(
                    room.game()+" closed spectator room");
                require(true,room.game()+" host room closure revokes sockets");
            }
            abortAll(sockets);
            awaitCount(services.socket(),0,"final shutdown");
            services.socket().stop(2500);
            services=null;
            awaitPortRelease(port);
            require(true,"restarted listener released its port after soak");
            if(report!=null) {
                var completed=new JsonObject();
                completed.addProperty("kind","complete");
                completed.addProperty("rounds",rounds);
                completed.addProperty("checks",checks);
                completed.addProperty("elapsedMs",(System.nanoTime()-started)/1_000_000);
                completed.addProperty("listenerReleased",true);
                appendReport(report,completed);
            }
            System.out.println("GAME_ROOM_R14G_ENDURANCE_PASSED checks="+checks
                +" rounds="+rounds+" games=2 spectators=12"
                +" heapBeforeBytes="+heapBefore+" heapAfterBytes="+usedHeap()
                +" threadBefore="+threadsBefore
                +" threadAfter="+ManagementFactory.getThreadMXBean()
                    .getThreadCount()
                +" elapsedMs="+(System.nanoTime()-started)/1_000_000);
        } finally {
            if(services!=null) try{services.socket().stop(2500);}
                catch(InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            try(var paths=Files.walk(root)) {
                paths.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try{Files.deleteIfExists(p);}
                    catch(Exception ignored){}
                });
            } finally {
                if(report!=null)report.close();
            }
        }
    }

    private static void appendReport(BufferedWriter writer,JsonObject record)
        throws Exception {
        writer.write(record.toString());
        writer.newLine();
        writer.flush();
    }
    private static void recordRound(BufferedWriter writer,int round,
        double durationMs,BoardGameWebSocketServer socket) throws Exception {
        var threads=ManagementFactory.getThreadMXBean();
        var memory=ManagementFactory.getMemoryMXBean();
        long gcCount=0,gcTime=0;
        for(var collector:ManagementFactory.getGarbageCollectorMXBeans()) {
            if(collector.getCollectionCount()>=0)
                gcCount+=collector.getCollectionCount();
            if(collector.getCollectionTime()>=0)
                gcTime+=collector.getCollectionTime();
        }
        var sample=new JsonObject();
        sample.addProperty("kind","sample");
        sample.addProperty("round",round);
        sample.addProperty("elapsedRoundMs",durationMs);
        sample.addProperty("heapUsedBytes",memory.getHeapMemoryUsage().getUsed());
        sample.addProperty("heapCommittedBytes",memory.getHeapMemoryUsage().getCommitted());
        sample.addProperty("nonHeapUsedBytes",memory.getNonHeapMemoryUsage().getUsed());
        sample.addProperty("threadCount",threads.getThreadCount());
        sample.addProperty("peakThreadCount",threads.getPeakThreadCount());
        sample.addProperty("gcCount",gcCount);
        sample.addProperty("gcTimeMs",gcTime);
        sample.addProperty("connectedSockets",socket.connectedClients());
        appendReport(writer,sample);
    }

    private static Services start(BoardGameDatabase database,int port)
        throws Exception {
        var access=new GameRoomAccessService(database);
        var active=new AtomicReference<BoardGameWebSocketServer>();
        var events=new GameRoomRealtimeService(database,access,(room,json)->{
            var ws=active.get();
            if(ws!=null)ws.broadcastRoomEvent(room,json);
        });
        var socket=new BoardGameWebSocketServer("127.0.0.1",port,
            code->false,null,code->false,access,events);
        active.set(socket);
        socket.start();
        return new Services(access,events,socket);
    }
    private static List<List<Client>> connectAll(HttpClient http,int port,
        List<RoomSession> rooms,long after,Services services) throws Exception {
        var groups=new ArrayList<List<Client>>();
        for(var room:rooms) {
            URI url=URI.create("ws://127.0.0.1:"+port+"/?memberRoomId="
                +room.roomId());
            var clients=new ArrayList<Client>();
            groups.add(clients);
            for(var member:room.guests()) {
                var observer=new Observer();
                WebSocket socket=null;
                Throwable error=null;
                for(int attempt=0;attempt<20;attempt++) {
                    try {
                        socket=http.newWebSocketBuilder().buildAsync(url,observer)
                            .get(3,TimeUnit.SECONDS);
                        break;
                    }catch(Exception failure) {
                        error=failure;
                        Thread.sleep(100);
                    }
                }
                if(socket==null)
                    throw new AssertionError("R14g WebSocket connect failed",error);
                clients.add(new Client(socket,observer));
                socket.sendText("{\"type\":\"room.subscribe\",\"token\":\""
                    +member.token()+"\",\"afterSequence\":"+after+"}",true)
                    .get(3,TimeUnit.SECONDS);
                String snapshot=observer.await("\"type\":\"room.snapshot\"",
                    room.game()+" authenticated snapshot");
                require(snapshot.contains("\"playerCount\":1")
                        && snapshot.contains("\"memberCount\":"
                            +(SPECTATORS+1)),
                    room.game()+" snapshot retained host/player/spectator counts");
                Thread.sleep(CONNECTION_PAUSE_MILLIS);
            }
        }
        require(services.socket().connectedClients()==rooms.size()*SPECTATORS,
            "exact expected live transport clients after reconnect");
        return groups;
    }
    private static void checkAll(List<Client> clients,String id,long sequence,
        String description) throws Exception {
        for(var client:clients) {
            String message=client.observer().await(id,description);
            require(message.contains("\"sequence\":"+sequence),
                description+" durable event sequence");
        }
    }
    private static void abortAll(List<List<Client>> groups) {
        for(var group:groups)for(var client:group)
            try{client.socket().abort();}catch(RuntimeException ignored){}
    }
    private static void awaitCount(BoardGameWebSocketServer server,int expected,
        String description) throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
        while(System.nanoTime()<deadline) {
            if(server.connectedClients()==expected)return;
            Thread.sleep(50);
        }
        throw new AssertionError("R14g: "+description
            +" left "+server.connectedClients()+" connected sockets");
    }
    private static void awaitPortRelease(int port) throws Exception {
        Exception last=null;
        for(int attempt=0;attempt<50;attempt++) {
            try(var listener=new ServerSocket()) {
                listener.setReuseAddress(true);
                listener.bind(new InetSocketAddress("127.0.0.1",port));
                return;
            }catch(Exception error) {
                last=error;
                Thread.sleep(100);
            }
        }
        throw new AssertionError("R14g WS listener port not released",last);
    }
    private static String messageId(String game,String phase,int round) {
        return "r14g-"+game+"-"+phase+"-"+round;
    }
    private static int freePort() throws Exception {
        try(var socket=new ServerSocket(0)) { return socket.getLocalPort(); }
    }
    private static long usedHeap() {
        var runtime=Runtime.getRuntime();
        return runtime.totalMemory()-runtime.freeMemory();
    }
    private static void require(boolean valid,String message) {
        if(!valid)throw new AssertionError("R14g: "+message);
        checks++;
    }
}
