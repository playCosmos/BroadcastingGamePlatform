package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomDrawingService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomRealtimeService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import io.github.playcosmos.broadcastinggameplatform.room.BoardGameRuntimeEngine;
import io.github.playcosmos.broadcastinggameplatform.room.RoomService;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * R5 acceptance: real member HTTP + drawing WebSocket + room WebSocket,
 * multiple simultaneous connections and authenticated replay.
 * No fake socket, browser callback or in-memory HTTP client is involved.
 * Full real-browser/touch/remote TLS acceptance remains a separate gate.
 */
public final class GameRoomDrawingR5TransportProbe {
    private GameRoomDrawingR5TransportProbe() {}
    private static final String API="/api/v1/room-membership";
    private static int checks;

    private static final class Observer implements WebSocket.Listener {
        final LinkedBlockingQueue<String> inbox=new LinkedBlockingQueue<>();
        final AtomicInteger closed=new AtomicInteger(-1);
        final StringBuilder fragment=new StringBuilder();

        @Override public void onOpen(WebSocket ws){ws.request(1);}
        @Override public CompletionStage<?> onText(
            WebSocket ws,CharSequence data,boolean last) {
            fragment.append(data);
            if(last){inbox.offer(fragment.toString());fragment.setLength(0);}
            ws.request(1);
            return null;
        }
        @Override public CompletionStage<?> onClose(
            WebSocket ws,int code,String reason) {
            closed.set(code);
            return CompletableFuture.completedFuture(null);
        }
        @Override public void onError(WebSocket ws,Throwable failure) {
            closed.set(1011);
        }
        String expect(String marker)throws Exception {
            for(int n=0;n<40;n++){
                var event=inbox.poll(125,TimeUnit.MILLISECONDS);
                if(event!=null && event.contains(marker))return event;
            }
            throw new AssertionError("missing WS event "+marker+
                " close="+closed.get()+" pending="+inbox.size());
        }
        void expectPolicyClose()throws Exception {
            for(int n=0;n<40;n++){
                if(closed.get()==1008)return;
                if(closed.get()!=-1)
                    throw new AssertionError("expected WS 1008, got "+closed.get());
                Thread.sleep(125);
            }
            throw new AssertionError("expected WS 1008; got "+closed.get());
        }
    }

    public static void main(String[] args)throws Exception {
        Path root=Files.createTempDirectory("drawing-r5-live-");
        GameClientHttpServer http=null;
        BoardGameWebSocketServer websocket=null;
        List<WebSocket> sockets=new ArrayList<>();
        try {
            Path assets=root.resolve("web/games/drawing-guess/room");
            Files.createDirectories(assets);
            for(String name:List.of("index.html","room.js","room.css")){
                Files.copy(Path.of("..","web","games","drawing-guess","room",name),
                    assets.resolve(name));
            }
            Files.writeString(root.resolve("web/index.html"),"live R5 test");
            int adminPort=port(),httpPort=port(),wsPort=port();
            var config=new BoardServerConfig("",
                new BoardServerConfig.Server("127.0.0.1",adminPort,wsPort,
                    false,"127.0.0.1",httpPort,"",""),
                new BoardServerConfig.Storage("./data/game.db","./web","./logs"),
                new BoardServerConfig.Soop(false,30)).normalized();
            var database=new BoardGameDatabase(root.resolve("data/game.db"));
            database.initialize();
            var access=new GameRoomAccessService(database);
            var canvas=new DrawingSyncService(database);
            var repository=new DrawingGuessRepository(database);
            var game=new DrawingGuessGameService(repository,canvas);
            var live=new AtomicReference<BoardGameWebSocketServer>();
            var realtime=new GameRoomRealtimeService(database,access,(id,event)->{
                var server=live.get();
                if(server!=null)server.broadcastRoomEvent(id,event);
            });
            var drawing=new GameRoomDrawingService(database,access,repository,
                game,canvas,(code,event)->{
                    var server=live.get();
                    if(server!=null)server.broadcastDrawingEvent(code,event);
                });
            websocket=new BoardGameWebSocketServer("127.0.0.1",wsPort,
                code->false,canvas,code->false,access,realtime);
            live.set(websocket);
            websocket.start();
            http=new GameClientHttpServer(config,root,new RoomService(database),
                new BoardGameRuntimeEngine(database,e->{}),
                new AdminAuthStore(database),new PlatformEventBus(),
                new ProviderRegistry(),null,canvas,game,null,access,realtime,
                null,drawing);
            http.start();
            var client=HttpClient.newHttpClient();
            URI base=URI.create("http://127.0.0.1:"+httpPort);
            String wsBase="ws://127.0.0.1:"+wsPort+"/?";
            var page=send(client,base,"/games/drawing-guess/room/",
                "GET",null,null);
            check(page.statusCode()==200 &&
                page.body().contains("id=\"canvas\"") &&
                page.body().contains("id=\"guessForm\""),
                "production HTML is served by live platform HTTP");
            var script=send(client,base,"/games/drawing-guess/room/room.js",
                "GET",null,null);
            check(script.statusCode()==200 &&
                script.body().contains("request(\"/drawing/canvas\""),
                "production member-only Canvas script is actually served");

            var room=access.createHostedRoom("drawing_guess","Live room",
                "Host",SeatRole.PLAYER,2,3);
            String host=room.hostCredential().token();
            String roomId=room.room().roomId();
            var guest=access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofMinutes(5)).token(),"Player two");
            var viewer=access.join(access.invite(host,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(5)).token(),"Audience");
            check(access.room(host).memberCount()==3 &&
                access.room(host).playerCount()==2 &&
                access.room(host).spectatorCount()==1,
                "host + player + spectator share total occupancy");
            String guestToken=guest.token(),viewerToken=viewer.token();
            var a=new Observer();
            var hostSocket=connect(client,URI.create(wsBase+"memberRoomId="+roomId),a);
            sockets.add(hostSocket);
            hostSocket.sendText(subscribe(host,-1),true).get(3,TimeUnit.SECONDS);
            check(a.expect("\"type\":\"room.snapshot\"").contains("\"memberCount\":3"),
                "real host WS confirms room membership snapshot");
            var b=new Observer();
            var viewerSocket=connect(client,URI.create(wsBase+"memberRoomId="+roomId),b);
            sockets.add(viewerSocket);
            viewerSocket.sendText(subscribe(viewerToken,-1),true)
                .get(3,TimeUnit.SECONDS);
            check(b.expect("\"type\":\"room.snapshot\"").contains("\"playerCount\":2"),
                "real spectator WS subscribes without player promotion");

            check(post(client,base,API+"/me/ready","{\"ready\":true}",host)
                .statusCode()==200,"host ready via HTTP");
            check(post(client,base,API+"/me/ready","{\"ready\":true}",guestToken)
                .statusCode()==200,"second player ready via HTTP");
            var start=post(client,base,API+"/drawing/start",
                "{\"mode\":\"ROTATING_DRAWER\",\"rounds\":2,\"durationSeconds\":120}",host);
            check(start.statusCode()==200 &&
                start.body().contains("\"configuredRounds\":2"),
                "live game reserves immutable settings");
            var started=post(client,base,API+"/drawing/round",
                "{\"promptId\":\"r5-transport-word\",\"answer\":\"kiwi\",\"acceptedAnswers\":[]}",
                host);
            check(started.statusCode()==200 &&
                !started.body().contains("kiwi") &&
                !started.body().contains("drawerToken"),
                "public response never exposes answer or native drawer token");
            var nativeState=drawing.state(host);
            String roundId=nativeState.game().activeRound().roundId();
            String code=canvas.drawingCodeForRound(roundId);
            check(code!=null && !code.isBlank(),"round drawing code is active");
            var drawerToken=canvas.reissueDrawerToken(roundId).drawerToken();
            check(!canvas.isAuthorizedDrawer(code,drawerToken),
                "native drawer bearer cannot authorize member room");

            var wrong=new Observer();
            var wrongSocket=connect(client,URI.create(wsBase+"drawingCode="+code+
                "&drawerToken="+drawerToken),wrong);
            sockets.add(wrongSocket);
            wrong.expectPolicyClose();
            check(true,"raw native token denied WS write channel");

            var observer1=new Observer();
            var drawOne=connect(client,URI.create(wsBase+"drawingCode="+code),observer1);
            sockets.add(drawOne);
            var observer2=new Observer();
            var drawTwo=connect(client,URI.create(wsBase+"drawingCode="+code),observer2);
            sockets.add(drawTwo);

            var unauthorized=post(client,base,API+"/drawing/canvas",
                event("canvas.clear","{}"),viewerToken);
            check(unauthorized.statusCode()==403,
                "spectator cannot write member-owned Canvas");
            var cleared=post(client,base,API+"/drawing/canvas",
                event("canvas.clear","{}"),host);
            check(cleared.statusCode()==200 &&
                cleared.body().contains("canvas.clear"),
                "authorized Canvas HTTP commit succeeds");
            check(observer1.expect("canvas.clear").contains("\"sequence\":1"),
                "first browser socket receives canonical sequence 1");
            check(observer2.expect("canvas.clear").contains("\"sequence\":1"),
                "second browser socket receives same sequence 1");

            var stroke=post(client,base,API+"/drawing/canvas",
                event("canvas.stroke.begin",
                    "{\"stroke\":{\"strokeId\":\"line-a\",\"points\":[{\"x\":0.1,\"y\":0.2}]}}"),
                host);
            check(stroke.statusCode()==200 &&
                stroke.body().contains("\"sequence\":2"),
                "stroke begin is committed exactly once in order");
            check(observer1.expect("canvas.stroke.begin").contains("\"sequence\":2"),
                "first browser receives live stroke");
            check(observer2.expect("canvas.stroke.begin").contains("\"sequence\":2"),
                "second browser receives live stroke");
            var samples=post(client,base,API+"/drawing/canvas",
                event("canvas.stroke.points",
                    "{\"strokeId\":\"line-a\",\"points\":[{\"x\":0.3,\"y\":0.4},{\"x\":0.7,\"y\":0.8}]}"),
                host);
            check(samples.statusCode()==200 &&
                samples.body().contains("\"sequence\":3"),
                "two real pointer samples sent in one authorized HTTP batch");
            check(observer1.expect("canvas.stroke.points").contains("\"sequence\":3"),
                "Canvas batch streamed with original ordering");
            check(observer2.expect("canvas.stroke.points").contains("\"sequence\":3"),
                "concurrent spectator receives identical Canvas batch");
            check(post(client,base,API+"/drawing/canvas",
                event("canvas.stroke.end","{\"strokeId\":\"line-a\"}"),
                host).statusCode()==200,"stroke end committed");
            observer1.expect("canvas.stroke.end");
            observer2.expect("canvas.stroke.end");

            var replay=new Observer();
            var reconnect=connect(client,URI.create(wsBase+"drawingCode="+code),replay);
            sockets.add(reconnect);
            check(replay.expect("canvas.clear").contains("\"sequence\":1") &&
                replay.expect("canvas.stroke.begin").contains("\"sequence\":2") &&
                replay.expect("canvas.stroke.points").contains("\"sequence\":3") &&
                replay.expect("canvas.stroke.end").contains("\"sequence\":4"),
                "reconnected browser replays persisted Canvas in strict order");

            drawTwo.sendText("{\"type\":\"canvas.clear\",\"payload\":{}}",true)
                .get(3,TimeUnit.SECONDS);
            observer2.expectPolicyClose();
            check(true,"unauthenticated drawing spectator WS cannot inject Canvas");

            check(post(client,base,API+"/chat",
                "{\"messageId\":\"r5-live-chat\",\"text\":\"kiwi\"}",viewerToken)
                .statusCode()==201,"spectator chat is allowed separately");
            check(a.expect("r5-live-chat").contains("kiwi"),
                "host receives live member-room chat broadcast");
            check(b.expect("r5-live-chat").contains("kiwi"),
                "spectator receives same member-room chat");
            check(drawing.state(host).game().participants().stream()
                .allMatch(p->p.score()==0),
                "normal chat with answer text never scores a guess");
            var guess=post(client,base,API+"/drawing/guess",
                "{\"text\":\"kiwi\"}",viewerToken);
            check(guess.statusCode()==200 &&
                guess.body().contains("\"status\":\"CORRECT\""),
                "spectator uses dedicated answer endpoint, not chat");
            check(post(client,base,API+"/drawing/guess",
                "{\"text\":\"kiwi\"}",host).body().contains("DRAWER_IGNORED"),
                "drawer cannot self-award answer points");

            access.kick(host,viewer.memberId());
            check(send(client,base,API+"/drawing","GET",null,viewerToken)
                .statusCode()==403,"kicked spectator loses room state access");
            check(post(client,base,API+"/drawing/guess",
                "{\"text\":\"kiwi\"}",viewerToken).statusCode()==403,
                "kicked spectator loses answer permission");
            check(post(client,base,API+"/chat",
                "{\"messageId\":\"r5-after-kick\",\"text\":\"blocked\"}",viewerToken)
                .statusCode()==403,"kicked spectator loses chat permission");
            check(post(client,base,API+"/chat",
                "{\"messageId\":\"r5-valid-chat\",\"text\":\"hello\"}",host)
                .statusCode()==201,"other members continue chatting after kick");
            b.expectPolicyClose();
            check(true,"previously subscribed member socket closes after revocation");

            System.out.println("GAME_ROOM_DRAWING_R5_LIVE_TRANSPORT_PASSED checks="+checks+
                " participants=3 sockets=concurrent canvas=ordered-replayed"+
                " token-ws=denied revoked-member=closed"+
                " chat=separate spectator-guess=correct");
        } finally {
            for(var socket:sockets)try{socket.abort();}catch(RuntimeException ignored){}
            if(http!=null)http.close();
            if(websocket!=null)try{websocket.stop(1500);}
                catch(InterruptedException interrupted){Thread.currentThread().interrupt();}
            try(var walk=Files.walk(root)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try{Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }

    private static String subscribe(String token,int after) {
        return "{\"type\":\"room.subscribe\",\"token\":\""+token+
            "\",\"afterSequence\":"+after+"}";
    }
    private static String event(String type,String payload) {
        return "{\"event\":{\"type\":\""+type+"\",\"payload\":"+payload+"}}";
    }
    private static JsonObject read(HttpResponse<String> response) {
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }
    private static HttpResponse<String> post(HttpClient client,URI base,
        String path,String json,String token)throws Exception {
        return send(client,base,path,"POST",json,token);
    }
    private static HttpResponse<String> send(HttpClient client,URI base,
        String path,String method,String json,String token)throws Exception {
        var request=HttpRequest.newBuilder(base.resolve(path))
            .header("Accept","application/json");
        if(token!=null)request.header("Authorization","Bearer "+token);
        if("POST".equals(method)){
            request.header("Origin",base.toString());
            request.header("Content-Type","application/json");
            request.POST(HttpRequest.BodyPublishers.ofString(json));
        }else request.GET();
        return client.send(request.build(),HttpResponse.BodyHandlers.ofString());
    }
    private static WebSocket connect(HttpClient client,URI uri,Observer who)
        throws Exception {
        Exception last=null;
        for(int n=0;n<30;n++){
            try{return client.newWebSocketBuilder().buildAsync(uri,who)
                .get(3,TimeUnit.SECONDS);}
            catch(Exception error){last=error;Thread.sleep(100);}
        }
        throw new IllegalStateException("WS unavailable",last);
    }
    private static int port()throws Exception {
        try(var available=new ServerSocket(0)){return available.getLocalPort();}
    }
    private static void check(boolean okay,String explanation){
        checks++;
        if(!okay)throw new AssertionError(explanation);
    }
}
