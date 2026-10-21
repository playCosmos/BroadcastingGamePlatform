package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring.Category;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRoomService;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomRealtimeService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomYachtService;
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
import java.util.HashSet;

/** Real HTTP-only common-member Yacht game: 2 players, spectator, 26 turns. */
public final class GameRoomYachtR4HttpProbe {
    private GameRoomYachtR4HttpProbe() {}
    private static int checks;
    private static final String ROOT = "/api/v1/room-membership";

    public static void main(String[] args) throws Exception {
        Path baseDir = Files.createTempDirectory("game-room-yacht-r4-");
        GameClientHttpServer web = null;
        try {
            Path webFolder = baseDir.resolve("web/games/yacht");
            Files.createDirectories(webFolder);
            Files.writeString(webFolder.resolve("index.html"), "<title>R4 Yacht</title>");
            Files.writeString(baseDir.resolve("web/index.html"),"R4 test home");
            int adminPort = port(), clientPort = port(), wsPort = port();
            var config = new BoardServerConfig("",
                new BoardServerConfig.Server("127.0.0.1",adminPort,wsPort,
                    false,"127.0.0.1",clientPort,"",""),
                new BoardServerConfig.Storage("./data/game.db","./web","./logs"),
                new BoardServerConfig.Soop(false,30)).normalized();
            var db = new BoardGameDatabase(baseDir.resolve("data/game.db"));
            db.initialize();
            var admin = new AdminAuthStore(db);
            admin.createSession("yacht-r4-admin",Instant.now().plusSeconds(2400));
            var access = new GameRoomAccessService(db);
            var realtime = new GameRoomRealtimeService(db,access,(id,json)->{});
            var yacht = new YachtRoomService(db,()->1,(code,json)->{});
            var shared = new GameRoomYachtService(db,access,yacht);
            web = new GameClientHttpServer(config,baseDir,new RoomService(db),
                new BoardGameRuntimeEngine(db,event->{}),admin,
                new PlatformEventBus(),new ProviderRegistry(),
                null,null,null,yacht,access,realtime,shared);
            web.start();
            URI base = URI.create("http://127.0.0.1:"+clientPort);
            var client = HttpClient.newHttpClient();
            String create = """
                {"gameId":"yacht","name":"26 turns","displayName":"Host",
                 "hostSeat":"PLAYER","maxPlayers":2,"maxRoomMembers":5}
                """;
            var created = request(client,base,ROOT+"/hosted","POST",create,
                null,"BGP_ADMIN_SESSION=yacht-r4-admin");
            require(created.statusCode()==201, "admin creates R4 shared room");
            var hostJson = parse(created);
            String host = hostJson.get("token").getAsString();
            String roomId=hostJson.getAsJsonObject("room").get("roomId").getAsString();
            String gameCode=hostJson.getAsJsonObject("room").get("roomCode").getAsString();
            var adminAsset=request(client,base,"/games/yacht/","GET",null,null,null);
            require(adminAsset.statusCode()==200 && adminAsset.body().contains("R4 Yacht"),
                "independent game route served without administrator page nesting");
            require(request(client,base,ROOT+"/yacht","GET",null,null,null)
                .statusCode()==403,"public member state is private");
            var before=asState(request(client,base,ROOT+"/yacht","GET",null,host,null));
            require(!before.has("yacht") || before.get("yacht").isJsonNull(),
                "no match is started prematurely");
            require(request(client,base,ROOT+"/yacht/start","POST","{}",host,null)
                .statusCode()==409,"host cannot start without two ready players");

            String invite=access.invite(host,
                io.github.playcosmos.broadcastinggameplatform.platform.rooms
                    .GameRoomModels.SeatRole.PLAYER,1,Duration.ofMinutes(40))
                .token();
            var admitted=request(client,base,ROOT+"/join","POST",
                "{\"invitation\":\""+invite+"\",\"displayName\":\"Guest\"}",
                null,null);
            require(admitted.statusCode()==201,"guest player joins by invite");
            String guest=parse(admitted).get("token").getAsString();
            String hostId=parse(created).get("memberId").getAsString();
            String guestId=parse(admitted).get("memberId").getAsString();
            require(request(client,base,ROOT+"/me/ready","POST",
                "{\"ready\":true}",host,null).statusCode()==200,"host ready");
            require(request(client,base,ROOT+"/me/ready","POST",
                "{\"ready\":true}",guest,null).statusCode()==200,"guest ready");
            require(request(client,base,ROOT+"/yacht/start","POST","{}",guest,null)
                .statusCode()==403,"nonhost cannot start");
            var started=asState(request(client,base,ROOT+"/yacht/start","POST","{}",
                host,null));
            var match=started.getAsJsonObject("yacht").getAsJsonObject("match");
            require("ACTIVE".equals(match.get("phase").getAsString())
                && match.getAsJsonArray("players").size()==2,
                "only joined and ready actual players become Yacht players");
            require(started.getAsJsonObject("room").get("memberCount").getAsInt()==2
                && started.getAsJsonObject("room").get("playerCount").getAsInt()==2,
                "shared member and player counts stable on start");
            var startedAgain=asState(request(client,base,ROOT+"/yacht/start","POST",
                "{}",host,null));
            require(startedAgain.getAsJsonObject("yacht").getAsJsonObject("match")
                .get("id").getAsString().equals(match.get("id").getAsString()),
                "repeated start preserves one match and original player seats");
            require(request(client,base,ROOT+"/me/seat","POST",
                "{\"seatRole\":\"SPECTATOR\"}",guest,null).statusCode()==409,
                "playing participant cannot escape locked active game by changing seat");
            String thirdPlayer=access.invite(host,
                io.github.playcosmos.broadcastinggameplatform.platform.rooms
                    .GameRoomModels.SeatRole.SPECTATOR,1,Duration.ofMinutes(30))
                .token();
            var watch=request(client,base,ROOT+"/join","POST",
                "{\"invitation\":\""+thirdPlayer+"\",\"displayName\":\"Watcher\"}",
                null,null);
            require(watch.statusCode()==201,"new spectator can enter an active game");
            String viewer=parse(watch).get("token").getAsString();
            var watcherState=asState(request(client,base,ROOT+"/yacht","GET",null,
                viewer,null));
            require(watcherState.getAsJsonObject("room").get("memberCount").getAsInt()==3
                && watcherState.getAsJsonObject("room").get("playerCount").getAsInt()==2,
                "spectator contributes to total capacity but not player count");
            require(request(client,base,ROOT+"/yacht/roll","POST",
                "{\"commandId\":\"spectator-roll\",\"expectedVersion\":1}",
                viewer,null).statusCode()==403,
                "spectator cannot roll or modify server dice");
            require(request(client,base,ROOT+"/yacht/roll","POST",
                "{\"commandId\":\"foreign-roll\",\"expectedVersion\":1}",
                "https://attacker.invalid",null).statusCode()==403,
                "cross-origin command cannot bypass member authorization");
            // Client cannot submit face values even with an authenticated PLAYER.
            require(request(client,base,ROOT+"/yacht/roll","POST",
                "{\"commandId\":\"dice-injection\",\"expectedVersion\":1,\"dice\":[6,6,6,6,6]}",
                host,null).statusCode()==400,"direct dice injection rejected");

            var tokenById=java.util.Map.of(hostId,host,guestId,guest);
            var seen=new HashSet<String>();
            int turns=0;
            while(turns<26){
                var fresh=asState(request(client,base,ROOT+"/yacht","GET",null,
                    host,null));
                var activeMatch=fresh.getAsJsonObject("yacht").getAsJsonObject("match");
                if("FINISHED".equals(activeMatch.get("phase").getAsString()))break;
                int index=activeMatch.get("currentPlayer").getAsInt();
                String actorId=activeMatch.getAsJsonArray("players")
                    .get(index).getAsJsonObject().get("id").getAsString();
                String actor=tokenById.get(actorId);
                require(actor!=null,"game uses only real invited member IDs");
                int version=activeMatch.get("version").getAsInt();
                String nonActor=actor.equals(host)?guest:host;
                require(request(client,base,ROOT+"/yacht/roll","POST",
                    "{\"commandId\":\"out-of-turn-"+turns+"\",\"expectedVersion\":"+version+"}",
                    nonActor,null).statusCode()==403,
                    "another player cannot roll current turn "+turns);
                String rollJson="{\"commandId\":\"r4roll-"+turns+
                    "\",\"expectedVersion\":"+version+"}";
                var roll=request(client,base,ROOT+"/yacht/roll","POST",rollJson,
                    actor,null);
                require(roll.statusCode()==200,"current PLAYER may roll "+turns);
                var rollBody=asState(roll);
                var rollMatch=rollBody.getAsJsonObject("yacht").getAsJsonObject("match");
                int versionAfter=rollMatch.get("version").getAsInt();
                require(rollMatch.get("rolls").getAsInt()==1
                    && rollMatch.getAsJsonArray("dice").get(0).getAsInt()==1,
                    "server-controlled RNG applied at turn "+turns);
                var replay=request(client,base,ROOT+"/yacht/roll","POST",rollJson,
                    actor,null);
                require(replay.statusCode()==200
                    && asState(replay).getAsJsonObject("yacht").getAsJsonObject("match")
                        .get("version").getAsInt()==versionAfter,
                    "idempotent roll does not generate new dice "+turns);
                if(turns==0){
                    var held=request(client,base,ROOT+"/yacht/hold","POST",
                        "{\"commandId\":\"r4hold-0\",\"expectedVersion\":"+versionAfter+
                        ",\"held\":[true,false,false,false,false]}",actor,null);
                    require(held.statusCode()==200,"current player may hold five-die mask");
                    versionAfter=asState(held).getAsJsonObject("yacht")
                        .getAsJsonObject("match").get("version").getAsInt();
                }
                String category=Category.values()[turns / 2].id();
                var score=request(client,base,ROOT+"/yacht/score","POST",
                    "{\"commandId\":\"r4score-"+turns+
                    "\",\"expectedVersion\":"+versionAfter+
                    ",\"category\":\""+category+"\"}",actor,null);
                require(score.statusCode()==200,
                    "real authenticated HTTP scores "+category+" turn "+turns);
                var after=asState(score).getAsJsonObject("yacht").getAsJsonObject("match");
                require(after.get("completedTurns").getAsInt()==turns+1,
                    "exactly one score completion "+turns);
                seen.add(category);
                turns++;
            }
            require(turns==26 && seen.size()==13,"complete two-player 26-turn game");
            var finished=asState(request(client,base,ROOT+"/yacht","GET",null,
                viewer,null));
            require("FINISHED".equals(finished.getAsJsonObject("yacht")
                .getAsJsonObject("match").get("phase").getAsString())
                && "POST_GAME".equals(finished.getAsJsonObject("room")
                    .get("state").getAsString()),
                "spectator sees final scores and shared room transitions to POST_GAME");
            require(finished.getAsJsonObject("room").get("memberCount").getAsInt()==3,
                "host+two players? actual total host, guest, spectator = 3");
            var reopenedDb=new BoardGameDatabase(baseDir.resolve("data/game.db"));
            reopenedDb.initialize();
            var recovered=new GameRoomYachtService(reopenedDb,
                new GameRoomAccessService(reopenedDb),
                new YachtRoomService(reopenedDb,(code,json)->{}));
            require(recovered.state(viewer).yacht().match().completedTurns()==26
                && recovered.state(host).room().state()
                   ==io.github.playcosmos.broadcastinggameplatform.platform.rooms
                       .GameRoomModels.RoomState.POST_GAME,
                "room-to-match link and completed score survive DB reopen");
            System.out.println("GAME_ROOM_YACHT_R4_PASSED checks="+checks
                +" full_http_turns="+turns+" player_acl=server"
                +" spectator=midgame host_ready=true"
                +" roll_hold_score=player_authorized dice=server_only"
                +" duplicate_command=stable recovery=sqlite");
        } finally {
            if(web!=null)web.close();
            try(var files=Files.walk(baseDir)){
                files.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try{Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }

    private static com.google.gson.JsonObject parse(HttpResponse<String> response) {
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }
    private static com.google.gson.JsonObject asState(HttpResponse<String> response) {
        require(response.statusCode()==200,
            "state/action HTTP 200 required, got "+response.statusCode()+" "+response.body());
        return parse(response);
    }
    private static HttpResponse<String> request(HttpClient client,URI base,
        String path,String method,String json,String credential,String cookie)
        throws Exception {
        var builder=HttpRequest.newBuilder(base.resolve(path))
            .header("Accept","application/json");
        if(credential!=null && credential.startsWith("http"))
            builder.header("Origin",credential);
        else if(credential!=null)builder.header("Authorization","Bearer "+credential);
        if(cookie!=null)builder.header("Cookie",cookie);
        if("POST".equals(method)){
            builder.header("Origin",base.toString());
            builder.header("Content-Type","application/json");
            builder.POST(HttpRequest.BodyPublishers.ofString(json));
        }else builder.GET();
        return client.send(builder.build(),HttpResponse.BodyHandlers.ofString());
    }
    private static int port() throws Exception {
        try(var socket=new ServerSocket(0)){return socket.getLocalPort();}
    }
    private static void require(boolean okay,String message) {
        checks++;
        if(!okay)throw new AssertionError(message);
    }
}
