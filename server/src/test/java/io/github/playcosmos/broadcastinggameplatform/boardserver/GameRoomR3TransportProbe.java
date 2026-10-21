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
        void expectClose()throws Exception {
            for(int i=0;i<25;i++){
                if(closeCode.get()==1008)return;
                Thread.sleep(80);
            }
            throw new AssertionError("expected WebSocket 1008: "+closeCode.get());
        }
    }

    public static void main(String[] args)throws Exception{
        Path root=Files.createTempDirectory("room-r3-transport-");
        GameClientHttpServer httpServer=null;
        BoardGameWebSocketServer ws=null;
        WebSocket hostSocket=null,guestSocket=null,illegalSocket=null,
                  recoverySocket=null,boardSocket=null;
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
            var realtime=new GameRoomRealtimeService(db,access,(id,json)->{
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

            System.out.println("GAME_ROOM_TRANSPORT_R3_PASSED checks="+checks
                +" http=authenticated websocket=member-only"
                +" replay=recovered chat=room-isolated"
                +" tombstone=redacted prior_channels=unchanged");
        } finally {
            for(var client:new WebSocket[]{hostSocket,guestSocket,illegalSocket,
                                          recoverySocket,boardSocket}){
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
