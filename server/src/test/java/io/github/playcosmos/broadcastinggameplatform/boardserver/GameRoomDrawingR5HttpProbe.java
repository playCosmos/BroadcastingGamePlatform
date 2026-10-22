package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRoomService;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomDrawingService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomRealtimeService;
import io.github.playcosmos.broadcastinggameplatform.room.BoardGameRuntimeEngine;
import io.github.playcosmos.broadcastinggameplatform.room.RoomService;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;

/** Real HTTP member room rotating drawer: answers private, score and restart. */
public final class GameRoomDrawingR5HttpProbe {
    private GameRoomDrawingR5HttpProbe() {}
    private static int checks;
    private static final String ROOT="/api/v1/room-membership";

    public static void main(String[] args) throws Exception {
        Path dir=Files.createTempDirectory("game-room-r5-");
        GameClientHttpServer server=null;
        try {
            Files.createDirectories(dir.resolve("web"));
            Files.writeString(dir.resolve("web/index.html"),"<html>R5</html>");
            int adminPort=port(),clientPort=port(),wsPort=port();
            var config=new BoardServerConfig("",
                new BoardServerConfig.Server("127.0.0.1",adminPort,wsPort,
                    false,"127.0.0.1",clientPort,"",""),
                new BoardServerConfig.Storage("./data/main.db","./web","./logs"),
                new BoardServerConfig.Soop(false,30)).normalized();
            var db=new BoardGameDatabase(dir.resolve("data/main.db"));
            db.initialize();
            var auth=new AdminAuthStore(db);
            auth.createSession("r5-fixture",Instant.now().plusSeconds(1800));
            var roomAccess=new GameRoomAccessService(db);
            var nativeRepo=new DrawingGuessRepository(db);
            var sync=new DrawingSyncService(db);
            var legacyGame=new DrawingGuessGameService(nativeRepo,sync);
            var sharedDrawing=new GameRoomDrawingService(
                db,roomAccess,legacyGame,nativeRepo,sync);
            server=new GameClientHttpServer(config,dir,new RoomService(db),
                new BoardGameRuntimeEngine(db,event->{}),auth,
                new PlatformEventBus(),new ProviderRegistry(),
                null,sync,legacyGame,new YachtRoomService(db,(code,json)->{}),
                roomAccess,new GameRoomRealtimeService(db,roomAccess,(id,json)->{}),
                null,sharedDrawing);
            server.start();
            var client=HttpClient.newHttpClient();
            URI base=URI.create("http://127.0.0.1:"+clientPort);
            var created=send(client,base,ROOT+"/hosted","POST","""
                {"gameId":"drawing_guess","name":"Rotation Test","displayName":"Host",
                 "hostSeat":"PLAYER","maxPlayers":3,"maxRoomMembers":5}
                """,null,"BGP_ADMIN_SESSION=r5-fixture");
            check(created.statusCode()==201,"admin creates common drawing room");
            String host=body(created).get("token").getAsString();
            String hostId=body(created).get("memberId").getAsString();
            String invite=roomAccess.invite(host,
                io.github.playcosmos.broadcastinggameplatform.platform.rooms
                    .GameRoomModels.SeatRole.PLAYER,1,Duration.ofMinutes(20)).token();
            var joined=send(client,base,ROOT+"/join","POST",
                "{\"invitation\":\""+invite+"\",\"displayName\":\"Guest\"}",null,null);
            check(joined.statusCode()==201,"guest joins as second player");
            String guest=body(joined).get("token").getAsString();
            String guestId=body(joined).get("memberId").getAsString();
            check(send(client,base,ROOT+"/drawing","GET",null,null,null)
                .statusCode()==403,"anonymous cannot query drawing room");
            check(send(client,base,ROOT+"/drawing/start","POST",
                "{\"totalRounds\":2,\"roundDurationSeconds\":80}",guest,null)
                .statusCode()==403,"nonhost cannot start");
            check(send(client,base,ROOT+"/drawing/start","POST",
                "{\"totalRounds\":2,\"roundDurationSeconds\":80}",host,null)
                .statusCode()==409,"unready players block game start");
            for(String token:new String[]{host,guest})
                check(send(client,base,ROOT+"/me/ready","POST",
                    "{\"ready\":true}",token,null).statusCode()==200,
                    "each member readies");
            var started=send(client,base,ROOT+"/drawing/start","POST",
                "{\"totalRounds\":2,\"roundDurationSeconds\":80}",host,null);
            check(started.statusCode()==200,"connected ready host starts room match: "
                +started.statusCode()+" "+started.body());
            check("PLAYING".equals(body(started).getAsJsonObject("room")
                .get("state").getAsString()),"shared room frozen to PLAYING");
            check(send(client,base,ROOT+"/me/seat","POST",
                "{\"seatRole\":\"SPECTATOR\"}",guest,null).statusCode()==409,
                "native drawer roster cannot change after game start");
            var spectatorInvite=roomAccess.invite(host,
                io.github.playcosmos.broadcastinggameplatform.platform.rooms
                    .GameRoomModels.SeatRole.SPECTATOR,1,Duration.ofMinutes(20)).token();
            var visitor=send(client,base,ROOT+"/join","POST",
                "{\"invitation\":\""+spectatorInvite+
                "\",\"displayName\":\"Viewer\"}",null,null);
            check(visitor.statusCode()==201,"spectator enters while match playing");
            String viewer=body(visitor).get("token").getAsString();
            check(body(send(client,base,ROOT+"/drawing","GET",null,viewer,null))
                .getAsJsonObject("room").get("memberCount").getAsInt()==3,
                "player+spectator+host count correct");
            check(send(client,base,ROOT+"/drawing/next-round","POST",
                "{\"answer\":\"비밀정답\"}",viewer,null).statusCode()==403,
                "spectator cannot set secret prompt");
            check(send(client,base,ROOT+"/drawing/next-round","POST",
                "{\"answer\":\"비밀정답\"}",guest,null).statusCode()==403,
                "non-drawer player cannot provide secret prompt");

            var one=send(client,base,ROOT+"/drawing/next-round","POST",
                "{\"answer\":\"비밀정답\",\"acceptedAnswers\":[\"secret alias\"]}",
                host,null);
            check(one.statusCode()==201,
                "first rotating drawer opens round: "+one.statusCode()+" "+one.body());
            var secret=body(one).getAsJsonObject("privateDrawer");
            String token1=secret.get("drawerToken").getAsString();
            String drawingCode=secret.get("drawingCode").getAsString();
            check(sync.isAuthorizedDrawer(drawingCode,token1),
                "first drawer gets native validated drawing token");
            var view1=send(client,base,ROOT+"/drawing","GET",null,guest,null);
            check(view1.statusCode()==200
                && !view1.body().contains("비밀정답")
                && !view1.body().contains(token1),
                "other PLAYER state cannot leak answer or canvas credential");
            var spectatorView=send(client,base,ROOT+"/drawing","GET",null,viewer,null);
            check(spectatorView.statusCode()==200
                && !spectatorView.body().contains("비밀정답")
                && !spectatorView.body().contains("actorId")
                && !spectatorView.body().contains("drawerToken"),
                "spectator public state excludes prompt, actor IDs and drawer secret");
            check(send(client,base,ROOT+"/drawing/drawer-recovery","POST",
                "{}",guest,null).statusCode()==403,
                "other player cannot recover secret drawer token");
            check(send(client,base,ROOT+"/drawing/guess","POST",
                "{\"guess\":\"비밀정답\"}",host,null).statusCode()==403,
                "current drawer cannot guess own prompt");
            check("WRONG".equals(body(send(client,base,ROOT+"/drawing/guess",
                "POST","{\"guess\":\"not that\"}",guest,null))
                .get("status").getAsString()),"guest wrong guess is not scored");
            var guessed=send(client,base,ROOT+"/drawing/guess","POST",
                "{\"guess\":\"secret alias\"}",guest,null);
            check(guessed.statusCode()==200
                && "CORRECT".equals(body(guessed).get("status").getAsString()),
                "member guest scores using native GuessJudge");
            check("DUPLICATE_CORRECT".equals(body(send(client,base,
                ROOT+"/drawing/guess","POST","{\"guess\":\"secret alias\"}",
                guest,null)).get("status").getAsString()),
                "second correct guess doesn't award twice");
            check(send(client,base,ROOT+"/drawing/end-round","POST","{}",
                viewer,null).statusCode()==403,"spectator cannot end active round");
            check(send(client,base,ROOT+"/drawing/end-round","POST","{}",
                host,null).statusCode()==200,"active drawer ends own round");
            check(!sync.isActive(drawingCode),
                "native canvas session closes when round completes");
            var second=send(client,base,ROOT+"/drawing/next-round","POST",
                "{\"answer\":\"두번째정답\"}",guest,null);
            check(second.statusCode()==201,"second player becomes next drawer");
            var privateSecond=body(second).getAsJsonObject("privateDrawer");
            check(send(client,base,ROOT+"/drawing/drawer-recovery","POST",
                "{}",host,null).statusCode()==403,
                "prior drawer has no new private credential");
            check(send(client,base,ROOT+"/drawing/drawer-recovery","POST",
                "{}",guest,null).statusCode()==200,
                "current drawer recovers their canvas credentials");
            check(!privateSecond.get("drawerToken").getAsString().equals(token1),
                "round tokens do not carry over to next drawer");
            check("CORRECT".equals(body(send(client,base,ROOT+"/drawing/guess",
                "POST","{\"guess\":\"두번째정답\"}",host,null))
                .get("status").getAsString()),"first drawer guesses second round");
            check(send(client,base,ROOT+"/drawing/end-round","POST","{}",
                guest,null).statusCode()==200,"second drawer completes round");
            check(send(client,base,ROOT+"/drawing/finish","POST","{}",
                viewer,null).statusCode()==403,"spectator cannot finish match");
            var completed=send(client,base,ROOT+"/drawing/finish","POST","{}",
                host,null);
            check(completed.statusCode()==200
                && "POST_GAME".equals(body(completed).getAsJsonObject("room")
                    .get("state").getAsString()),
                "host closes finished rotation and updates shared room");
            var reopened=new BoardGameDatabase(dir.resolve("data/main.db"));
            reopened.initialize();
            var recovered=new GameRoomDrawingService(reopened,
                new GameRoomAccessService(reopened),
                new DrawingGuessGameService(
                    new DrawingGuessRepository(reopened),new DrawingSyncService(reopened)),
                new DrawingGuessRepository(reopened),new DrawingSyncService(reopened));
            check(recovered.state(host).totalRounds()==2
                && recovered.state(host).room().state()
                    ==io.github.playcosmos.broadcastinggameplatform.platform.rooms
                        .GameRoomModels.RoomState.POST_GAME,
                "R5 link and post-game state survive SQLite restart");
            System.out.println("GAME_ROOM_DRAWING_R5_PASSED checks="+checks
                +" rotation=2 private_prompt=true canvas_acl=drawer"
                +" guess=member_only spectator=allowed chat=separate"
                +" scoring=2_rounds recovery=sqlite");
        }finally{
            if(server!=null)server.close();
            try(var walk=Files.walk(dir)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try{Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }
    private static JsonObject body(HttpResponse<String> response) {
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }
    private static HttpResponse<String> send(HttpClient client,URI base,
        String path,String method,String payload,String token,String cookie)throws Exception {
        var b=HttpRequest.newBuilder(base.resolve(path));
        if(token!=null)b.header("Authorization","Bearer "+token);
        if(cookie!=null)b.header("Cookie",cookie);
        if("POST".equals(method)){
            b.header("Origin",base.toString());
            b.header("Content-Type","application/json");
            b.POST(HttpRequest.BodyPublishers.ofString(payload));
        }else b.GET();
        return client.send(b.build(),HttpResponse.BodyHandlers.ofString());
    }
    private static int port()throws Exception{
        try(var s=new ServerSocket(0)){return s.getLocalPort();}
    }
    private static void check(boolean value,String message){
        checks++;
        if(!value)throw new AssertionError(message);
    }
}
