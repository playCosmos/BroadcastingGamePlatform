package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomRealtimeService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import io.github.playcosmos.broadcastinggameplatform.room.BoardGameRuntimeEngine;
import io.github.playcosmos.broadcastinggameplatform.room.RoomService;
import java.net.URI;
import java.net.ServerSocket;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Full authenticated REST -> committed event -> WS -> cursor-reconnect path. */
public final class GameRoomR3TransportProbe {
    private GameRoomR3TransportProbe(){}
    private static int checks;

    private static final class Observer implements WebSocket.Listener {
        final LinkedBlockingQueue<String> inbox=new LinkedBlockingQueue<>();
        final AtomicInteger closeCode=new AtomicInteger(-1);
        final StringBuilder pending=new StringBuilder();
        @Override public void onOpen(WebSocket socket){socket.request(1);}
        @Override public CompletionStage<?> onText(
            WebSocket socket,CharSequence data,boolean last) {
            pending.append(data);
            if(last){inbox.offer(pending.toString());pending.setLength(0);}
            socket.request(1);
            return null;
        }
        @Override public CompletionStage<?> onClose(
            WebSocket socket,int code,String reason){
            closeCode.set(code);
            return CompletableFuture.completedFuture(null);
        }
        @Override public void onError(WebSocket socket,Throwable error){
            closeCode.set(1011);
        }
        String expect(String substring)throws Exception {
            for(int i=0;i<25;i++){
                String got=inbox.poll(150,TimeUnit.MILLISECONDS);
                if(got!=null && got.contains(substring))return got;
            }
            throw new AssertionError("expected socket message "+substring
                +"; close="+closeCode.get());
        }
        boolean noMessage()throws Exception {
            return inbox.poll(300,TimeUnit.MILLISECONDS)==null;
        }
        boolean noMessageFor(long millis)throws Exception {
            return inbox.poll(millis,TimeUnit.MILLISECONDS)==null;
        }
        void expectClose()throws Exception {
            expectCloseCode(1008);
        }
        void expectCloseCode(int expected)throws Exception {
            // JDK HttpClient WebSocket onClose delivery can lag behind the
            // server's close frame on heavily scheduled Windows CI runners.
            // Assert the actual code, never accept arbitrary closure.
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            while(System.nanoTime()<deadline){
                int code=closeCode.get();
                if(code==expected)return;
                if(code>0)throw new AssertionError(
                    "expected WebSocket "+expected+", received "+code);
                Thread.sleep(80);
            }
            throw new AssertionError(
                "expected WebSocket "+expected+" within 8s: "+closeCode.get());
        }
    }

    public static void main(String[] args)throws Exception{
        Path root=Files.createTempDirectory("room-r3-transport-");
        GameClientHttpServer httpServer=null;
        BoardGameWebSocketServer ws=null;
        WebSocket hostSocket=null,guestSocket=null,illegalSocket=null,
                  recoverySocket=null,boardSocket=null,sqlFailureSocket=null,
                  restoredSocket=null,pagedSocket=null,
                  raceSocket=null,orderedSocket=null;
        try {
            Path web=root.resolve("web");
            Files.createDirectories(web);
            Files.writeString(web.resolve("index.html"),"room test");
            int adminPort=port(),httpPort=port(),wsPort=port();
            var config=new BoardServerConfig("",new BoardServerConfig.Server(
                "127.0.0.1",adminPort,wsPort,false,
                "127.0.0.1",httpPort,"",""),
                new BoardServerConfig.Storage("./data/rooms.db","./web","./logs"),
                new BoardServerConfig.Soop(false,30)).normalized();
            var db=new BoardGameDatabase(root.resolve("data/rooms.db"));
            db.initialize();
            var access=new GameRoomAccessService(db);
            var live=new AtomicReference<BoardGameWebSocketServer>();
            var deliveryGate=new AtomicReference<java.util.function.Consumer<String>>(
                ignored -> {});
            var realtime=new GameRoomRealtimeService(db,access,(id,json)->{
                deliveryGate.get().accept(json);
                var socket=live.get();
                if(socket!=null)socket.broadcastRoomEvent(id,json);
            });
            var first=access.createHostedRoom("yacht","First","Host",
                SeatRole.PLAYER,2,4);
            var second=access.createHostedRoom("drawing_guess","Second","Other",
                SeatRole.SPECTATOR,3,4);
            String token=first.hostCredential().token(), roomId=first.room().roomId();
            String otherRoom=second.room().roomId();
            var guest=access.join(access.invite(token,SeatRole.SPECTATOR,2,
                Duration.ofMinutes(20)).token(),"Viewer");
            ws=new BoardGameWebSocketServer("127.0.0.1",wsPort,
                code->false,null,code->false,access,realtime);
            live.set(ws);
            ws.start();
            httpServer=new GameClientHttpServer(config,root,new RoomService(db),
                new BoardGameRuntimeEngine(db,event->{}),new AdminAuthStore(db),
                new PlatformEventBus(),new ProviderRegistry(),
                null,null,null,null,access,realtime);
            httpServer.start();
            var client=HttpClient.newHttpClient();
            URI base=URI.create("http://127.0.0.1:"+httpPort);
            URI socketUri=URI.create("ws://127.0.0.1:"+wsPort+"/?memberRoomId="+roomId);
            var owner=new Observer();
            hostSocket=connect(client,socketUri,owner);
            hostSocket.sendText(subscribe(token,-1),true).get(3,TimeUnit.SECONDS);
            String snapshot=owner.expect("\"type\":\"room.snapshot\"");
            check(snapshot.contains("\"memberCount\":2")
                && snapshot.contains("\"playerCount\":1"),
                "room WS authenticated snapshot has exact player/total counts");
            owner.expect("\"type\":\"room.presence.changed\"");
            check(!snapshot.contains(token) && !snapshot.contains("actorId"),
                "WS snapshot cannot expose bearer token or internal actor");

            var stranger=new Observer();
            illegalSocket=connect(client,socketUri,stranger);
            illegalSocket.sendText(subscribe(second.hostCredential().token(),-1),
                true).get(3,TimeUnit.SECONDS);
            stranger.expectClose();
            check(owner.noMessage(),"other room cannot leak events to first room");
            var guestListener=new Observer();
            guestSocket=connect(client,socketUri,guestListener);
            guestSocket.sendText(subscribe(guest.token(),-1),true)
                .get(3,TimeUnit.SECONDS);
            guestListener.expect("\"type\":\"room.snapshot\"");
            guestListener.expect("\"connected\":true");

            String path="/api/v1/room-membership/chat";
            var unauthorized=send(client,base.resolve(path),"POST",
                "{\"messageId\":\"r3http00001\",\"text\":\"no\"}",
                base.toString(),null);
            check(unauthorized.statusCode()==403,
                "room chat REST denies anonymous writers");
            var foreign=send(client,base.resolve(path),"POST",
                "{\"messageId\":\"r3http00002\",\"text\":\"blocked\"}",
                "https://attacker.invalid",token);
            check(foreign.statusCode()==403,
                "room chat rejects foreign web Origin");
            var delivered=send(client,base.resolve(path),"POST",
                "{\"messageId\":\"r3http00003\",\"text\":\"Hello Room\"}",
                base.toString(),token);
            check(delivered.statusCode()==201
                && delivered.body().contains("\"sequence\":1"),
                "REST committed first chat with sequence 1");
            check(owner.expect("\"messageId\":\"r3http00003\"")
                .contains("Hello Room"),"owner receives committed real WS chat");
            check(guestListener.expect("\"messageId\":\"r3http00003\"")
                .contains("Hello Room"),"guest receives same scoped WS event");
            check(owner.noMessage(),"chat commit not rebroadcast without mutation");
            var replayed=send(client,base.resolve(path),"POST",
                "{\"messageId\":\"r3http00003\",\"text\":\"Hello Room\"}",
                base.toString(),token);
            check(replayed.statusCode()==201
                && replayed.body().contains("\"sequence\":1")
                && owner.noMessage(),
                "identical HTTP retry returns prior event without WS repeat");
            var events=send(client,base.resolve(
                "/api/v1/room-membership/events?since=0"),"GET",null,null,token);
            check(events.statusCode()==200
                && events.body().contains("\"cursor\":1")
                && events.body().contains("\"messageId\":\"r3http00003\""),
                "REST event replay returns authenticated room-only cursor");

            hostSocket.abort();hostSocket=null;
            guestSocket.sendText("{\"type\":\"game.roll\"}",true)
                .get(3,TimeUnit.SECONDS);
            guestListener.expectClose();
            var next=send(client,base.resolve(path),"POST",
                "{\"messageId\":\"r3http00004\",\"text\":\"Offline delivery\"}",
                base.toString(),token);
            check(next.statusCode()==201,"socket outage cannot prevent chat persistence");
            var recovery=new Observer();
            recoverySocket=connect(client,socketUri,recovery);
            recoverySocket.sendText(subscribe(token,1),true).get(3,TimeUnit.SECONDS);
            recovery.expect("\"type\":\"room.snapshot\"");
            check(recovery.expect("\"messageId\":\"r3http00004\"")
                .contains("\"sequence\":2"),"WS subscribe replays missed committed event");

            var delete=send(client,base.resolve(path+"/delete"),"POST",
                "{\"messageId\":\"r3http00003\"}",base.toString(),token);
            check(delete.statusCode()==200
                && delete.body().contains("\"room.chat.deleted\""),
                "host deletes chat as sequenced tombstone");
            recovery.expect("\"type\":\"room.chat.deleted\"");
            var recent=send(client,base.resolve(
                "/api/v1/room-membership/chat?after=-1"),"GET",null,null,token);
            check(recent.statusCode()==200
                && recent.body().contains("\"deleted\":true")
                && !recent.body().contains("Hello Room"),
                "deleted chat never returns original text through REST");
            var separate=send(client,base.resolve(
                "/api/v1/room-membership/events?since=-1"),"GET",null,null,
                second.hostCredential().token());
            check(separate.statusCode()==200
                && !separate.body().contains("r3http00003"),
                "member of other room cannot read first room events");
            var kicked=access.kick(token,guest.memberId());
            check(kicked.memberCount()==1,"kicked guest frees one spectator seat");
            var kickedHistory=send(client,base.resolve(
                "/api/v1/room-membership/events?since=-1"),"GET",null,null,
                guest.token());
            check(kickedHistory.statusCode()==403,
                "kicked member token loses REST replay access");

            // Deliberately make the disposable fixture's session table
            // unavailable *after* all normal authorization/replay assertions.
            // The same valid token must get a retryable 1013, never a false
            // policy-violation 1008. Restore the schema before cleanup.
            try(var connection=db.open();
                var statement=connection.createStatement()){
                statement.execute("ALTER TABLE game_room_session"
                    +" RENAME TO probe_room_session_unavailable");
            }
            try {
                var sqlFailure=new Observer();
                sqlFailureSocket=connect(client,socketUri,sqlFailure);
                sqlFailureSocket.sendText(subscribe(token,-1),true)
                    .get(3,TimeUnit.SECONDS);
                sqlFailure.expectCloseCode(1013);
                check(sqlFailure.noMessage(),
                    "SQL outage never delivers authenticated room snapshot");
                // This already-subscribed host socket must also fail as
                // temporary server unavailability, not false revocation.
                check(!ws.broadcastRoomEvent(roomId,
                    "{\"type\":\"room.probe\",\"transportOnly\":true}"),
                    "SQL outage does not broadcast unverified member event");
                recovery.expectCloseCode(1013);
            } finally {
                try(var connection=db.open();
                    var statement=connection.createStatement()){
                    statement.execute("ALTER TABLE"
                        +" probe_room_session_unavailable"
                        +" RENAME TO game_room_session");
                }
            }
            var afterSql=send(client,base.resolve(
                "/api/v1/room-membership/me"),"GET",null,null,token);
            check(afterSql.statusCode()==200,
                "member REST credential remains valid after SQL fixture restore");
            var restored=new Observer();
            restoredSocket=connect(client,socketUri,restored);
            restoredSocket.sendText(subscribe(token,-1),true)
                .get(3,TimeUnit.SECONDS);
            restored.expect("\"type\":\"room.snapshot\"");
            check(ws.broadcastRoomEvent(roomId,
                "{\"type\":\"room.probe\",\"transportOnly\":true}"),
                "restored valid member can receive server room broadcast");
            restored.expect("\"type\":\"room.probe\"");

            // Deterministically keep presence fanout blocked while a REAL
            // authenticated socket closes. Capacity must be reclaimed before
            // onClose can acquire memberSendLock, or a reconnect can receive
            // an artificial 1013 if the global 256-connection cap is reached.
            var lockField=BoardGameWebSocketServer.class
                .getDeclaredField("memberSendLock");
            lockField.setAccessible(true);
            Object presenceLock=lockField.get(ws);
            var subscribersField=BoardGameWebSocketServer.class
                .getDeclaredField("roomSubscribers");
            subscribersField.setAccessible(true);
            var subscribers=(java.util.Map<?,?>)subscribersField.get(ws);
            int subscriptionsBefore=subscribers.size();
            int capacityBefore=ws.connectedClients();
            check(subscriptionsBefore>=1 && capacityBefore>=1,
                "R3 has an authenticated active socket before teardown");
            synchronized(presenceLock){
                restoredSocket.abort();
                restoredSocket=null;
                long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
                while(subscribers.size()>=subscriptionsBefore &&
                    System.nanoTime()<deadline)Thread.sleep(15);
                check(subscribers.size()==subscriptionsBefore-1,
                    "R3 onClose removed the member before presence fanout");
                while(ws.connectedClients()>=capacityBefore &&
                    System.nanoTime()<deadline)Thread.sleep(15);
                check(ws.connectedClients()==capacityBefore-1,
                    "R3 releases connection capacity despite blocked presence");
            }

            // Reconnect after 101 durable room events. A single R3 event
            // page is 100; the WebSocket transport must not silently omit
            // event 101. Insert a disposable sequential fixture directly
            // through real SQLite to avoid the normal five-chat/sec quota.
            long beforeReplay=realtime.lastSequence(token);
            var gson=new com.google.gson.Gson();
            try(var connection=db.open()){
                connection.setAutoCommit(false);
                try(var insert=connection.prepareStatement("""
                    INSERT INTO game_room_event
                    (room_id,sequence,event_type,payload,created_at)
                    VALUES(?,?,?,?,?)
                    """);
                    var roomVersion=connection.prepareStatement("""
                    UPDATE game_room SET event_sequence=?
                    WHERE room_id=?
                    """)){
                    for(int i=1;i<=101;i++){
                        long sequence=beforeReplay+i;
                        var event=new GameRoomRealtimeService.Event(
                            "room.probe",roomId,sequence,
                            first.hostCredential().memberId(),
                            "replay-page-"+i,null,null,
                            java.time.Instant.EPOCH.toString());
                        insert.setString(1,roomId);
                        insert.setLong(2,sequence);
                        insert.setString(3,"room.probe");
                        insert.setString(4,gson.toJson(event));
                        insert.setString(5,java.time.Instant.EPOCH.toString());
                        insert.addBatch();
                    }
                    insert.executeBatch();
                    roomVersion.setLong(1,beforeReplay+101);
                    roomVersion.setString(2,roomId);
                    check(roomVersion.executeUpdate()==1,
                        "R3 replay fixture persists room high-watermark");
                }
                connection.commit();
            }
            var paged=new Observer();
            pagedSocket=connect(client,socketUri,paged);
            pagedSocket.sendText(subscribe(token,beforeReplay),true)
                .get(3,TimeUnit.SECONDS);
            String pagedSnapshot=paged.expect("\"type\":\"room.snapshot\"");
            check(pagedSnapshot.contains("\"lastSequence\":"+
                (beforeReplay+101)),
                "R3 page replay snapshot exposes the exact durable high-watermark");
            for(int i=1;i<=101;i++){
                long sequence=beforeReplay+i;
                String replayedFrame=paged.expect("\"type\":\"room.probe\"");
                check(replayedFrame.contains("\"sequence\":"+sequence),
                    "R3 reconnect receives ordered durable event "+i);
            }
            check(paged.closeCode.get()<0 && ws.connectedClients()>=1,
                "R3 replay preserves the authenticated live member socket");


            // #167: commit can complete before its post-commit live callback.
            // Subscribe during that deliberate delay: the snapshot replay must
            // contain the event ONCE, and the late callback must not resend it.
            long beforeRace=realtime.lastSequence(token);
            String duplicateId="r3racedup001";
            var duplicateEntered=new java.util.concurrent.CountDownLatch(1);
            var duplicateRelease=new java.util.concurrent.CountDownLatch(1);
            deliveryGate.set(json -> gateDelivery(json,duplicateId,
                duplicateEntered,duplicateRelease));
            try {
                var pending=CompletableFuture.runAsync(() -> {
                    try { realtime.chat(token,duplicateId,"Race on reconnect"); }
                    catch(Exception failed) {
                        throw new java.util.concurrent.CompletionException(failed);
                    }
                });
                check(duplicateEntered.await(10,TimeUnit.SECONDS),
                    "R3 durable chat committed before blocked live callback");
                var race=new Observer();
                raceSocket=connect(client,socketUri,race);
                raceSocket.sendText(subscribe(token,beforeRace),true)
                    .get(3,TimeUnit.SECONDS);
                String raceSnapshot=race.expect("\"type\":\"room.snapshot\"");
                check(raceSnapshot.contains("\"lastSequence\":"+(beforeRace+1)),
                    "R3 reconnect captures pending committed durable sequence");
                check(race.expect("\"messageId\":\""+duplicateId+"\"")
                    .contains("\"sequence\":"+(beforeRace+1)),
                    "R3 reconnect replays pending event once");
                race.expect("\"type\":\"room.presence.changed\"");
                duplicateRelease.countDown();
                pending.get(10,TimeUnit.SECONDS);
                check(race.noMessageFor(1200),
                    "R3 delayed post-commit broadcast must not duplicate replay");
            } finally {
                duplicateRelease.countDown();
                deliveryGate.set(ignored -> {});
            }
            raceSocket.abort();
            raceSocket=null;

            // #167: two committed durable events may dispatch live callbacks
            // in reverse order. A subscriber must still see increasing sequence
            // exactly once, not event N+1 followed by event N.
            long beforeReverse=realtime.lastSequence(token);
            var ordered=new Observer();
            orderedSocket=connect(client,socketUri,ordered);
            orderedSocket.sendText(subscribe(token,beforeReverse),true)
                .get(3,TimeUnit.SECONDS);
            ordered.expect("\"type\":\"room.snapshot\"");
            ordered.expect("\"type\":\"room.presence.changed\"");
            String firstId="r3racefirst01",secondId="r3racesecond02";
            var reverseEntered=new java.util.concurrent.CountDownLatch(1);
            var reverseRelease=new java.util.concurrent.CountDownLatch(1);
            deliveryGate.set(json -> gateDelivery(json,firstId,
                reverseEntered,reverseRelease));
            try {
                var pending=CompletableFuture.runAsync(() -> {
                    try { realtime.chat(token,firstId,"First committed"); }
                    catch(Exception failed) {
                        throw new java.util.concurrent.CompletionException(failed);
                    }
                });
                check(reverseEntered.await(10,TimeUnit.SECONDS),
                    "R3 first durable commit held before live fanout");
                var secondCommitted=realtime.chat(token,secondId,"Second committed");
                check(secondCommitted.sequence()==beforeReverse+2,
                    "R3 later durable event committed after blocked first event");
                String orderedFirst=ordered.expect("\"type\":\"room.chat.message\"");
                String orderedSecond=ordered.expect("\"type\":\"room.chat.message\"");
                check(orderedFirst.contains("\"sequence\":"+(beforeReverse+1))
                    && orderedFirst.contains("\"messageId\":\""+firstId+"\"")
                    && orderedSecond.contains("\"sequence\":"+(beforeReverse+2))
                    && orderedSecond.contains("\"messageId\":\""+secondId+"\""),
                    "R3 reversed callbacks deliver contiguous ordered durable events");
                reverseRelease.countDown();
                pending.get(10,TimeUnit.SECONDS);
                check(ordered.noMessageFor(1200),
                    "R3 delayed earlier event callback never delivers a duplicate");
            } finally {
                reverseRelease.countDown();
                deliveryGate.set(ignored -> {});
            }

            // Native Yacht Y2 uses its own MATCH version/sequence but shares
            // this authenticated room socket for its 20-member fanout. It
            // must not consume the independent durable GAME_ROOM cursor.
            long beforeNative=realtime.lastSequence(token);
            String nativeFrame="{\"type\":\"yacht.dice.rolled\",\"sequence\":999999}";
            check(ws.broadcastRoomEvent(roomId,nativeFrame),
                "R3 native Yacht frame remains eligible for member fanout");
            check(ordered.expect("\"type\":\"yacht.dice.rolled\"")
                .contains("\"sequence\":999999"),
                "R3 native Yacht sequence bypasses room durable gap checks");
            var afterNative=realtime.chat(token,"r3racepost003","After native event");
            check(afterNative.sequence()==beforeNative+1
                && ordered.expect("\"messageId\":\"r3racepost003\"")
                .contains("\"sequence\":"+(beforeNative+1)),
                "R3 room durable cursor remains intact after native Yacht frame");

            System.out.println("GAME_ROOM_TRANSPORT_R3_PASSED checks="+checks
                +" http=authenticated websocket=member-only"
                +" replay=recovered chat=room-isolated"
                +" tombstone=redacted prior_channels=unchanged");
        } finally {
            for(var client:new WebSocket[]{hostSocket,guestSocket,illegalSocket,
                                          recoverySocket,boardSocket,
                                          sqlFailureSocket,restoredSocket,
                                          pagedSocket,raceSocket,orderedSocket}){
                if(client!=null)try{client.abort();}catch(RuntimeException ignored){}
            }
            if(httpServer!=null)httpServer.close();
            if(ws!=null)try{ws.stop(1500);}
                catch(InterruptedException e){Thread.currentThread().interrupt();}
            try(var files=Files.walk(root)){
                files.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }

    private static void gateDelivery(String json,String messageId,
        java.util.concurrent.CountDownLatch entered,
        java.util.concurrent.CountDownLatch release) {
        if(!json.contains("\"messageId\":\""+messageId+"\""))return;
        entered.countDown();
        try {
            if(!release.await(20,TimeUnit.SECONDS))
                throw new AssertionError("R3 delayed callback release timed out");
        } catch(InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("R3 delayed callback interrupted",interrupted);
        }
    }

    private static String subscribe(String secret,long cursor){
        return "{\"type\":\"room.subscribe\",\"token\":\""+secret
            +"\",\"afterSequence\":"+cursor+"}";
    }
    private static WebSocket connect(HttpClient client,URI uri,
                                     Observer listener)throws Exception{
        Exception last=null;
        for(int i=0;i<25;i++){
            try{return client.newWebSocketBuilder().buildAsync(uri,listener)
                .get(2,TimeUnit.SECONDS);}
            catch(Exception error){last=error;Thread.sleep(100);}
        }
        throw new IllegalStateException("WS startup failed",last);
    }
    private static HttpResponse<String> send(HttpClient client,URI uri,
        String method,String body,String origin,String secret)throws Exception{
        var builder=HttpRequest.newBuilder(uri);
        if(origin!=null)builder.header("Origin",origin);
        if(secret!=null)builder.header("Authorization","Bearer "+secret);
        if("POST".equals(method)){
            builder.header("Content-Type","application/json");
            builder.POST(HttpRequest.BodyPublishers.ofString(body));
        }else builder.GET();
        return client.send(builder.build(),HttpResponse.BodyHandlers.ofString());
    }
    private static int port()throws Exception{
        try(var socket=new ServerSocket(0)){return socket.getLocalPort();}
    }
    private static void check(boolean okay,String description){
        checks++;
        if(!okay)throw new AssertionError(description);
    }
}
