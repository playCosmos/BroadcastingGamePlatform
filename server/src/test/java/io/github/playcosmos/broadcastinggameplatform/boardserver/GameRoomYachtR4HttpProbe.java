package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtScoring.Category;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRoomService;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomService;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomRealtimeService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomYachtService;
import io.github.playcosmos.broadcastinggameplatform.room.BoardGameRuntimeEngine;
import io.github.playcosmos.broadcastinggameplatform.room.RoomService;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
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
            // Supply a valid PLAYER bearer with a genuinely foreign Origin.
            // Missing authentication must not be what makes this case pass.
            // Send exactly one Origin header; a second same-origin header
            // makes the rejection dependent on getFirst()/proxy behavior.
            var foreignRoll = HttpRequest.newBuilder(base.resolve(ROOT+"/yacht/roll"))
                .header("Accept","application/json")
                .header("Authorization","Bearer "+host)
                .header("Origin","https://attacker.invalid")
                .header("Content-Type","application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    "{\"commandId\":\"foreign-roll\",\"expectedVersion\":1}"))
                .build();
            require(client.send(foreignRoll,HttpResponse.BodyHandlers.ofString())
                .statusCode()==403,
                "valid player bearer with foreign Origin must be rejected");
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
            // R15h failure-mode acceptance: every persisted two-phase
            // start boundary must remain recoverable using the same host.
            interruptedYachtStartRecoveryAcceptance(client,base,access,db);
            sqliteBusyAfterFreezeAcceptance(access,db);
            concurrentYachtStartHttpAcceptance(client,base,access,db);
            sixPlayerCapacityAcceptance(client,base,access,db);
        } finally {
            if(web!=null)web.close();
            try(var files=Files.walk(baseDir)){
                files.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try{Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }

    /**
     * R14z: real common-member HTTP integration at both simultaneous limits:
     * 6 real PLAYERs + 14 SPECTATORs = 20 actual distinct members, then
     * 6 * 13 = 78 authoritative Yacht score turns with spectator readback.
     * Deliberately reuse the disposable R4 web listener/SQLite and admin
     * session without injecting game state, dice values or synthetic members.
     */
    private static void sixPlayerCapacityAcceptance(HttpClient client,URI base,
        GameRoomAccessService access,BoardGameDatabase db) throws Exception {
        var created=request(client,base,ROOT+"/hosted","POST", """
            {"gameId":"yacht","name":"R14z six-player full-capacity match",
             "displayName":"R14z Host","hostSeat":"PLAYER",
             "maxPlayers":6,"maxRoomMembers":20}
            """,null,"BGP_ADMIN_SESSION=yacht-r4-admin");
        require(created.statusCode()==201,"R14z admin creates six-player room");
        var hosted=parse(created);
        String host=hosted.get("token").getAsString();
        var tokens=new java.util.ArrayList<String>();
        var ids=new java.util.HashSet<String>();
        var tokenById=new java.util.HashMap<String,String>();
        tokens.add(host);
        String hostId=hosted.get("memberId").getAsString();
        ids.add(hostId);tokenById.put(hostId,host);
        var playerInvite=access.invite(host,
            io.github.playcosmos.broadcastinggameplatform.platform.rooms
                .GameRoomModels.SeatRole.PLAYER,5,Duration.ofMinutes(40)).token();
        for(int index=1;index<6;index++){
            var joined=request(client,base,ROOT+"/join","POST",
                "{\"invitation\":\""+playerInvite+"\",\"displayName\":\"R14z Player "+
                    index+"\"}",null,null);
            require(joined.statusCode()==201,"R14z player joined "+index);
            var admitted=parse(joined);
            String token=admitted.get("token").getAsString();
            String id=admitted.get("memberId").getAsString();
            require(ids.add(id),"R14z real player member IDs must be distinct");
            tokens.add(token);
            tokenById.put(id,token);
        }
        String overflowPlayer=access.invite(host,
            io.github.playcosmos.broadcastinggameplatform.platform.rooms
                .GameRoomModels.SeatRole.PLAYER,1,Duration.ofMinutes(40)).token();
        require(request(client,base,ROOT+"/join","POST",
            "{\"invitation\":\""+overflowPlayer+
                "\",\"displayName\":\"Overflow Player\"}",null,null).statusCode()==409,
            "R14z seventh player rejected before total room is full");
        String spectatorInvite=access.invite(host,
            io.github.playcosmos.broadcastinggameplatform.platform.rooms
                .GameRoomModels.SeatRole.SPECTATOR,15,Duration.ofMinutes(40)).token();
        var watchers=new java.util.ArrayList<String>();
        for(int index=0;index<14;index++){
            var entered=request(client,base,ROOT+"/join","POST",
                "{\"invitation\":\""+spectatorInvite+
                    "\",\"displayName\":\"R14z Spectator "+index+"\"}",null,null);
            require(entered.statusCode()==201,"R14z spectator joined "+index);
            var admitted=parse(entered);
            String token=admitted.get("token").getAsString();
            require(ids.add(admitted.get("memberId").getAsString()),
                "R14z spectator member must be distinct");
            watchers.add(token);
        }
        require(ids.size()==20 && tokens.size()==6 && watchers.size()==14,
            "R14z host counts once; exactly 20 independent joined members");
        var room=asState(request(client,base,ROOT+"/me","GET",null,host,null))
            .getAsJsonObject("room");
        require(room.get("memberCount").getAsInt()==20
            && room.get("playerCount").getAsInt()==6
            && room.get("memberCount").getAsInt()-room.get("playerCount").getAsInt()==14
            && room.get("maxPlayers").getAsInt()==6
            && room.get("maxRoomMembers").getAsInt()==20,
            "R14z distinct player and combined room capacities preserved");
        require(request(client,base,ROOT+"/join","POST",
            "{\"invitation\":\""+spectatorInvite+
                "\",\"displayName\":\"Overflow Spectator\"}",null,null).statusCode()==409,
            "R14z 21st member rejected despite unused spectator invitation");
        require(request(client,base,ROOT+"/me/seat","POST",
            "{\"seatRole\":\"PLAYER\"}",watchers.get(0),null).statusCode()==409,
            "R14z spectator promotion cannot exceed six player capacity");
        for(int i=0;i<tokens.size();i++){
            require(request(client,base,ROOT+"/me/ready","POST",
                "{\"ready\":true}",tokens.get(i),null).statusCode()==200,
                "R14z all six actual players ready "+i);
        }
        require(request(client,base,ROOT+"/yacht/start","POST","{}",
            watchers.get(0),null).statusCode()==403,
            "R14z spectator cannot start Yacht");
        var started=asState(request(client,base,ROOT+"/yacht/start","POST","{}",
            host,null));
        var match=started.getAsJsonObject("yacht").getAsJsonObject("match");
        require(match.getAsJsonArray("players").size()==6
            && "ACTIVE".equals(match.get("phase").getAsString())
            && started.getAsJsonObject("room").get("memberCount").getAsInt()==20,
            "R14z real match locks six players while retaining fourteen viewers");
        String matchId=match.get("id").getAsString();
        var legalCategories=Category.values();
        for(int turn=0;turn<78;turn++){
            var reading=asState(request(client,base,ROOT+"/yacht","GET",null,
                watchers.get(turn%watchers.size()),null));
            var current=reading.getAsJsonObject("yacht").getAsJsonObject("match");
            int playerIndex=current.get("currentPlayer").getAsInt();
            require("ACTIVE".equals(current.get("phase").getAsString())
                && current.get("completedTurns").getAsInt()==turn
                && playerIndex==turn%6
                && matchId.equals(current.get("id").getAsString()),
                "R14z all seventy-eight turns retain actual six-player rotation");
            String ownerId=current.getAsJsonArray("players").get(playerIndex)
                .getAsJsonObject().get("id").getAsString();
            String owner=tokenById.get(ownerId);
            require(owner!=null,"R14z active player belongs to real joined roster");
            int version=current.get("version").getAsInt();
            if(turn==0 || turn==77){
                require(request(client,base,ROOT+"/yacht/roll","POST",
                    "{\"commandId\":\"r14z-spectator-roll-"+turn+
                    "\",\"expectedVersion\":"+version+"}",
                    watchers.get(0),null).statusCode()==403,
                    "R14z spectator cannot roll at beginning or last turn");
                require(request(client,base,ROOT+"/yacht/roll","POST",
                    "{\"commandId\":\"r14z-nonactive-roll-"+turn+
                    "\",\"expectedVersion\":"+version+"}",
                    tokens.get((playerIndex+1)%6),null).statusCode()==403,
                    "R14z nonactive player cannot alter current turn");
            }
            var rolled=asState(request(client,base,ROOT+"/yacht/roll","POST",
                "{\"commandId\":\"r14z-roll-"+turn+
                    "\",\"expectedVersion\":"+version+"}",owner,null));
            var afterRoll=rolled.getAsJsonObject("yacht").getAsJsonObject("match");
            require(afterRoll.get("rolls").getAsInt()==1
                && afterRoll.get("version").getAsInt()>version,
                "R14z server dice roll commits in active player's turn");
            var choices=rolled.getAsJsonObject("yacht")
                .getAsJsonObject("availableScores").getAsJsonObject("points");
            Category selected=null;
            for(var candidate:legalCategories){
                if(choices.has(candidate.name())){selected=candidate;break;}
            }
            require(selected!=null,
                "R14z only legal server-authoritative score categories may be selected");
            String scoreBody="{\"commandId\":\"r14z-score-"+turn+
                "\",\"expectedVersion\":"+afterRoll.get("version").getAsInt()+
                ",\"category\":\""+selected.id()+"\"}";
            com.google.gson.JsonObject scored;
            if(turn==42){
                // #173: unlike a failed final-room transition, a midgame
                // native score must roll back its own SQLite transaction.
                // Fail the real score UPDATE once, keep this test-only
                // trigger scoped to the disposable HTTP fixture, and
                // preserve the exact commandId/version for manual replay.
                try(var connection=db.open();
                    var statement=connection.createStatement()){
                    statement.execute("""
                        CREATE TRIGGER probe_yacht_midturn_score_failure
                        BEFORE UPDATE OF state_json ON yacht_match
                        BEGIN SELECT RAISE(ABORT,'probe midgame score failed'); END
                        """);
                }
                try {
                    var failed=request(client,base,ROOT+"/yacht/score",
                        "POST",scoreBody,owner,null);
                    require(failed.statusCode()==500
                        && failed.body().contains("Yacht server error")
                        && !failed.body().contains("probe midgame score failed"),
                        "R15a midturn native score failure returns generic 500");
                    var persisted=new YachtRepository(db).find(matchId);
                    require(persisted.completedTurns()==turn
                        && persisted.version()==
                            afterRoll.get("version").getAsLong()
                        && persisted.rolls()==1
                        && "ACTIVE".equals(persisted.phase().name()),
                        "R15a failed score does not commit a turn or version");
                } finally {
                    try(var connection=db.open();
                        var statement=connection.createStatement()){
                        statement.execute(
                            "DROP TRIGGER IF EXISTS probe_yacht_midturn_score_failure");
                    }
                }
                var resumed=request(client,base,ROOT+"/yacht/score",
                    "POST",scoreBody,owner,null);
                require(resumed.statusCode()==200,
                    "R15a original score command commits after SQL failure clears");
                scored=asState(resumed);
                var repeated=asState(request(client,base,
                    ROOT+"/yacht/score","POST",scoreBody,owner,null));
                var original=scored.getAsJsonObject("yacht")
                    .getAsJsonObject("match");
                var replay=repeated.getAsJsonObject("yacht")
                    .getAsJsonObject("match");
                require(replay.get("completedTurns").getAsInt()==turn+1
                    && replay.get("version").getAsLong()==
                        original.get("version").getAsLong()
                    && matchId.equals(replay.get("id").getAsString()),
                    "R15a same commandId replay never double-scores turn 42");
                try(var connection=db.open();
                    var eventCount=connection.prepareStatement("""
                        SELECT COUNT(*) FROM yacht_event
                        WHERE match_id=? AND event_type='yacht.score.committed'
                        """);
                    var commandCount=connection.prepareStatement("""
                        SELECT COUNT(*) FROM yacht_command
                        WHERE match_id=? AND command_id=?
                        """)){
                    eventCount.setString(1,matchId);
                    commandCount.setString(1,matchId);
                    commandCount.setString(2,"r14z-score-"+turn);
                    try(var events=eventCount.executeQuery();
                        var commands=commandCount.executeQuery()){
                        require(events.next() && events.getInt(1)==turn+1
                            && commands.next() && commands.getInt(1)==1,
                            "R15a score failure/replay yields one score event"
                                +" and one idempotency command row");
                    }
                }
                System.out.println(
                    "GAME_ROOM_R15A_MIDTURN_SCORE_SQL_RECOVERY_PASSED"
                    +" turn=42 firstStatus=500 retryStatus=200"
                    +" sameCommand=true score=unique version=stable");
            }else if(turn==77){
                // The native final score commits BEFORE the common room is
                // transitioned to POST_GAME in a separate SQLite transaction.
                // Inject a real error only into that second transaction.
                // Recovery must replay the ORIGINAL command id, not score
                // an additional turn or create another native match.
                try(var connection=db.open();
                    var statement=connection.createStatement()){
                    statement.execute("""
                        CREATE TRIGGER probe_yacht_postgame_failure
                        BEFORE UPDATE OF state ON game_room
                        WHEN OLD.state='PLAYING' AND NEW.state='POST_GAME'
                        BEGIN SELECT RAISE(ABORT,'probe final transition failed'); END
                        """);
                }
                try {
                    var failed=request(client,base,ROOT+"/yacht/score",
                        "POST",scoreBody,owner,null);
                    require(failed.statusCode()==500
                        && failed.body().contains("Yacht server error")
                        && !failed.body().contains("probe final transition failed"),
                        "R14z post-commit SQL failure returns generic HTTP 500");
                    // The public GET also tries to reconcile POST_GAME,
                    // so it legitimately returns 500 while this trigger is
                    // installed. Read authoritative persisted state without
                    // triggering the unrelated self-heal write path.
                    var persisted=new YachtRepository(db).find(matchId);
                    var partialRoom=new GameRoomService(db).find(
                        room.get("roomId").getAsString());
                    require(persisted.completedTurns()==78
                        && "FINISHED".equals(persisted.phase().name())
                        && matchId.equals(persisted.id())
                        && persisted.version()>
                            afterRoll.get("version").getAsLong()
                        && "PLAYING".equals(partialRoom.state().name()),
                        "R14z final score durable while postgame room sync fails");
                } finally {
                    try(var connection=db.open();
                        var statement=connection.createStatement()){
                        statement.execute(
                            "DROP TRIGGER IF EXISTS probe_yacht_postgame_failure");
                    }
                }
                var resumed=request(client,base,ROOT+"/yacht/score",
                    "POST",scoreBody,owner,null);
                require(resumed.statusCode()==200,
                    "R14z same final command recovers common postgame state");
                scored=asState(resumed);
                var repeated=asState(request(client,base,
                    ROOT+"/yacht/score","POST",scoreBody,owner,null));
                var original=scored.getAsJsonObject("yacht")
                    .getAsJsonObject("match");
                var replay=repeated.getAsJsonObject("yacht")
                    .getAsJsonObject("match");
                require(replay.get("completedTurns").getAsInt()==78
                    && replay.get("version").getAsLong()==
                        original.get("version").getAsLong()
                    && matchId.equals(replay.get("id").getAsString())
                    && "POST_GAME".equals(repeated.getAsJsonObject("room")
                        .get("state").getAsString()),
                    "R14z final score retries cannot double-commit a turn");
            }else{
                scored=asState(request(client,base,ROOT+"/yacht/score",
                    "POST",scoreBody,owner,null));
            }
            var next=scored.getAsJsonObject("yacht").getAsJsonObject("match");
            require(next.get("completedTurns").getAsInt()==turn+1
                && next.get("currentPlayer").getAsInt()==(turn+1)%6
                && next.get("version").getAsInt()>
                    afterRoll.get("version").getAsInt()
                && (turn==77)==("FINISHED".equals(next.get("phase").getAsString()))
                && ((turn==77)?"POST_GAME":"PLAYING").equals(
                    scored.getAsJsonObject("room").get("state").getAsString()),
                "R14z score committed exactly once with authoritative round state");
        }
        for(String viewer:watchers){
            var snapshot=asState(request(client,base,ROOT+"/yacht","GET",
                null,viewer,null));
            var finalMatch=snapshot.getAsJsonObject("yacht").getAsJsonObject("match");
            require("FINISHED".equals(finalMatch.get("phase").getAsString())
                && finalMatch.get("completedTurns").getAsInt()==78
                && finalMatch.getAsJsonArray("players").size()==6
                && finalMatch.getAsJsonArray("players").asList().stream()
                    .allMatch(p->p.getAsJsonObject().getAsJsonObject("sheet")
                        .getAsJsonObject("scores").size()==13)
                && snapshot.getAsJsonObject("room").get("memberCount").getAsInt()==20
                && snapshot.getAsJsonObject("room").get("playerCount").getAsInt()==6
                && "POST_GAME".equals(snapshot.getAsJsonObject("room")
                    .get("state").getAsString()),
                "R14z every actual spectator sees completed 78-turn match and capacity");
        }
        System.out.println("GAME_ROOM_R14Z_SIX_PLAYER_CAPACITY_PASSED"+
            " players=6 spectators=14 members=20 turns=78"+
            " scoresPerPlayer=13 postGame=true");
    }

    /**
     * Deterministic failure injection for all three persisted Yacht startup
     * stages. Uses disposable probe SQLite only; no runtime fault hooks.
     * A failed start may leave the shared room PLAYING without a native link.
     * The same host must be able to resume without creating a second match.
     */
    private static void interruptedYachtStartRecoveryAcceptance(
        HttpClient client, URI base, GameRoomAccessService access,
        BoardGameDatabase db) throws Exception {
        for (String stage : new String[]{"create","activate","link"}) {
            String name="R15h interrupted startup "+stage;
            var hosted=request(client,base,ROOT+"/hosted","POST",
                "{\"gameId\":\"yacht\",\"name\":\""+name+
                "\",\"displayName\":\"Host\",\"hostSeat\":\"PLAYER\""+
                ",\"maxPlayers\":2,\"maxRoomMembers\":3}",
                null,"BGP_ADMIN_SESSION=yacht-r4-admin");
            require(hosted.statusCode()==201,
                "R15h creates isolated room for "+stage);
            var created=parse(hosted);
            String host=created.get("token").getAsString();
            String roomId=created.getAsJsonObject("room").get("roomId").getAsString();
            String invite=access.invite(host,
                io.github.playcosmos.broadcastinggameplatform.platform.rooms
                    .GameRoomModels.SeatRole.PLAYER,1,Duration.ofMinutes(10))
                .token();
            var admitted=request(client,base,ROOT+"/join","POST",
                "{\"invitation\":\""+invite+"\",\"displayName\":\"Guest\"}",
                null,null);
            require(admitted.statusCode()==201,
                "R15h guest joins before "+stage+" failure");
            String guest=parse(admitted).get("token").getAsString();
            require(request(client,base,ROOT+"/me/ready","POST",
                "{\"ready\":true}",host,null).statusCode()==200
                && request(client,base,ROOT+"/me/ready","POST",
                    "{\"ready\":true}",guest,null).statusCode()==200,
                "R15h players ready before "+stage+" failure");
            String trigger=switch(stage) {
                case "create" -> """
                    CREATE TRIGGER probe_yacht_start_failure
                    BEFORE INSERT ON yacht_match
                    BEGIN SELECT RAISE(ABORT,'probe forced create failure'); END
                    """;
                case "activate" -> """
                    CREATE TRIGGER probe_yacht_start_failure
                    BEFORE UPDATE OF phase ON yacht_match
                    WHEN NEW.phase='ACTIVE'
                    BEGIN SELECT RAISE(ABORT,'probe forced activate failure'); END
                    """;
                case "link" -> """
                    CREATE TRIGGER probe_yacht_start_failure
                    BEFORE INSERT ON game_room_yacht_link
                    BEGIN SELECT RAISE(ABORT,'probe forced link failure'); END
                    """;
                default -> throw new AssertionError("unknown failure stage");
            };
            try(var connection=db.open();var statement=connection.createStatement()){
                statement.execute(trigger);
            }
            var capturedErrors=new ByteArrayOutputStream();
            var originalErr=System.err;
            try {
                try(var capture=new PrintStream(
                    capturedErrors,true,StandardCharsets.UTF_8)) {
                    System.setErr(capture);
                    try {
                        var failed=request(client,base,ROOT+"/yacht/start","POST",
                            "{}",host,null);
                        require(failed.statusCode()==500,
                            "R15h injected "+stage+" database failure is not hidden");
                        require(!failed.body().contains("probe forced"),
                            "R15h injected SQL error detail not exposed over HTTP");
                    } finally {
                        System.setErr(originalErr);
                    }
                }
            } finally {
                try(var connection=db.open();
                    var statement=connection.createStatement()){
                    statement.execute("DROP TRIGGER IF EXISTS probe_yacht_start_failure");
                }
            }
            // Only a fixed stage and SQLite numeric result code may be logged.
            // The SQL driver message contains the synthetic 'probe forced' text
            // and must never escape into operator telemetry.
            String diagnostic=capturedErrors.toString(StandardCharsets.UTF_8);
            require(diagnostic.lines().filter(line -> line.matches(
                "\\[game-room-yacht\\] start_sql_failure stage="
                    + stage + " code=-?[0-9]+")).count()==1
                && diagnostic.lines().filter(line -> line.matches(
                    "\\[game-room-yacht\\] api_sql_failure operation=start"
                        + " code=-?[0-9]+")).count()==1,
                "R15h "+stage+" failure reports bounded start and API SQL codes");
            require(!diagnostic.contains("probe forced")
                && !diagnostic.contains(roomId)
                && !diagnostic.contains(host)
                && !diagnostic.contains(guest),
                "R15h "+stage+" diagnostic contains no credential or raw SQL");
            var interrupted=asState(request(client,base,ROOT+"/yacht","GET",
                null,host,null));
            require("PLAYING".equals(interrupted.getAsJsonObject("room")
                .get("state").getAsString())
                && (!interrupted.has("yacht") || interrupted.get("yacht").isJsonNull()),
                "R15h "+stage+" failure leaves retriable frozen room without link");
            if ("link".equals(stage)) {
                // The shared room is already PLAYING, so the disconnected
                // player retains their seat but disconnect clears ready.
                // Host retry must recover the same frozen two-player match.
                var graceful=access.disconnect(guest,Duration.ofMinutes(5));
                require(graceful.playerCount()==2
                    && graceful.members().stream().anyMatch(m ->
                        m.seatRole()==io.github.playcosmos.broadcastinggameplatform
                            .platform.rooms.GameRoomModels.SeatRole.PLAYER
                        && m.status()==io.github.playcosmos.broadcastinggameplatform
                            .platform.rooms.GameRoomModels.MemberStatus.DISCONNECTED_GRACE
                        && !m.ready()),
                    "R15h grace player still occupies frozen match seat");
            }
            var resumed=asState(request(client,base,ROOT+"/yacht/start","POST",
                "{}",host,null));
            var match=resumed.getAsJsonObject("yacht").getAsJsonObject("match");
            require("ACTIVE".equals(match.get("phase").getAsString())
                && match.getAsJsonArray("players").size()==2,
                "R15h host resumes "+stage+" with original player roster");
            String matchId=match.get("id").getAsString();
            var repeated=asState(request(client,base,ROOT+"/yacht/start","POST",
                "{}",host,null));
            require(matchId.equals(repeated.getAsJsonObject("yacht")
                .getAsJsonObject("match").get("id").getAsString()),
                "R15h repeated "+stage+" recovery reuses same match");
            if ("link".equals(stage)) {
                // Real authenticated command failure, not a mocked handler.
                // Before-update SQLite abort guarantees no roll has committed.
                try(var connection=db.open();
                    var statement=connection.createStatement()) {
                    statement.execute("""
                        CREATE TRIGGER probe_yacht_roll_sql_failure
                        BEFORE UPDATE OF version ON yacht_match
                        WHEN NEW.version > OLD.version
                        BEGIN SELECT RAISE(ABORT,'probe forced roll failure'); END
                        """);
                }
                long beforeVersion=match.get("version").getAsLong();
                String rollBody="{\"commandId\":\"r15h-roll-sql-probe\","
                    + "\"expectedVersion\":" + beforeVersion + "}";
                var rollErrors=new ByteArrayOutputStream();
                var previousErr=System.err;
                try {
                    try(var capture=new PrintStream(
                        rollErrors,true,StandardCharsets.UTF_8)) {
                        System.setErr(capture);
                        try {
                            var rejected=request(client,base,ROOT+"/yacht/roll",
                                "POST",rollBody,host,null);
                            require(rejected.statusCode()==500
                                && rejected.body().contains("Yacht server error")
                                && !rejected.body().contains("probe forced"),
                                "R15a injected command SQL failure is generic HTTP 500");
                        } finally { System.setErr(previousErr); }
                    }
                } finally {
                    try(var connection=db.open();
                        var statement=connection.createStatement()) {
                        statement.execute(
                            "DROP TRIGGER IF EXISTS probe_yacht_roll_sql_failure");
                    }
                }
                String rollDiagnostic=rollErrors.toString(StandardCharsets.UTF_8);
                require(rollDiagnostic.lines().filter(line -> line.matches(
                    "\\[game-room-yacht\\] api_sql_failure operation=command"
                        + " code=-?[0-9]+")).count()==1
                    && !rollDiagnostic.contains("probe forced")
                    && !rollDiagnostic.contains(roomId)
                    && !rollDiagnostic.contains(host)
                    && !rollDiagnostic.contains(guest),
                    "R15a SQL failure exposes only bounded operation and code");
                var afterFailure=asState(request(client,base,ROOT+"/yacht",
                    "GET",null,host,null));
                require(afterFailure.getAsJsonObject("yacht")
                    .getAsJsonObject("match").get("version").getAsLong()
                    ==beforeVersion,
                    "R15a rejected roll did not commit a new version");
                var rolled=asState(request(client,base,ROOT+"/yacht/roll",
                    "POST",rollBody,host,null));
                require(rolled.getAsJsonObject("yacht").getAsJsonObject("match")
                    .get("version").getAsLong()==beforeVersion+1,
                    "R15a retry of uncommitted roll commits one version");
                var replay=asState(request(client,base,ROOT+"/yacht/roll",
                    "POST",rollBody,host,null));
                require(replay.getAsJsonObject("yacht").getAsJsonObject("match")
                    .get("version").getAsLong()==beforeVersion+1,
                    "R15a command replay remains idempotent");
            }
            try(var connection=db.open();
                var nativeRooms=connection.prepareStatement(
                    "SELECT COUNT(*) FROM yacht_room WHERE create_key=?");
                var link=connection.prepareStatement(
                    "SELECT COUNT(*) FROM game_room_yacht_link WHERE room_id=?")){
                nativeRooms.setString(1,"common-yacht-"+roomId);
                link.setString(1,roomId);
                try(var nativeRows=nativeRooms.executeQuery();
                    var linkRows=link.executeQuery()){
                    require(nativeRows.next() && nativeRows.getInt(1)==1
                        && linkRows.next() && linkRows.getInt(1)==1,
                        "R15h "+stage+" recovery has exactly one match and link");
                }
            }
        }
        System.out.println("GAME_ROOM_R15H_PARTIAL_START_RECOVERY_PASSED"
            +" stages=create,activate,link match=unique auth=host");
    }


    /**
     * #123: a REAL competing SQLite writer can exhaust busy_timeout
     * between an already-committed PLAYING freeze and Y2 native creation.
     * Test-only short busy_timeout and latch; production DB/HTTP unchanged.
     * This classifies a possible stage=create / SQLITE_BUSY (5) failure,
     * not the unobserved root cause of the historical browser HTTP 500.
     */
    private static void sqliteBusyAfterFreezeAcceptance(
        GameRoomAccessService access, BoardGameDatabase db) throws Exception {
        var hosted=access.createHostedRoom("yacht",
            "R15h SQLite busy after freeze","Host",
            io.github.playcosmos.broadcastinggameplatform.platform.rooms
                .GameRoomModels.SeatRole.PLAYER,2,3);
        String host=hosted.hostCredential().token();
        String roomId=hosted.room().roomId();
        String guest=access.join(access.invite(host,
            io.github.playcosmos.broadcastinggameplatform.platform.rooms
                .GameRoomModels.SeatRole.PLAYER,1,
            Duration.ofMinutes(10)).token(),"Guest").token();
        access.ready(host,true);
        access.ready(guest,true);

        var armed=new java.util.concurrent.atomic.AtomicBoolean(true);
        var entered=new java.util.concurrent.CountDownLatch(1);
        var release=new java.util.concurrent.CountDownLatch(1);
        // Only the native Yacht service uses this test DB proxy. Lobby
        // freeze still uses the regular database connection and commits.
        io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess
            gatedNative=new io.github.playcosmos.broadcastinggameplatform
                .db.DatabaseAccess() {
            @Override public Path path(){return db.path();}
            @Override public java.sql.Connection open() throws java.sql.SQLException {
                if(armed.compareAndSet(true,false)){
                    entered.countDown();
                    try {
                        if(!release.await(12,java.util.concurrent.TimeUnit.SECONDS))
                            throw new java.sql.SQLException(
                                "test native open latch expired");
                    } catch(InterruptedException interrupted){
                        Thread.currentThread().interrupt();
                        throw new java.sql.SQLException(
                            "test native open latch interrupted",interrupted);
                    }
                }
                var connection=db.open();
                // Shorten only the disposable fixture's writer timeout;
                // the real BoardGameDatabase keeps its 5000-ms policy.
                try(var statement=connection.createStatement()){
                    statement.execute("PRAGMA busy_timeout=200");
                }
                return connection;
            }
        };
        var service=new GameRoomYachtService(db,access,
            new YachtRoomService(gatedNative,(code,json)->{}));
        var pending=java.util.concurrent.CompletableFuture.supplyAsync(()->{
            try {
                service.start(host);
                return (java.sql.SQLException)null;
            } catch(java.sql.SQLException sqlFailure){
                return sqlFailure;
            }
        });
        var originalErr=System.err;
        var captured=new ByteArrayOutputStream();
        try {
            require(entered.await(10,java.util.concurrent.TimeUnit.SECONDS),
                "R15h native create waits AFTER persisted lobby freeze");
            require(access.room(host).state()==
                io.github.playcosmos.broadcastinggameplatform.platform
                    .rooms.GameRoomModels.RoomState.PLAYING,
                "R15h native create gate sees committed PLAYING room");
            try(var capture=new PrintStream(
                captured,true,StandardCharsets.UTF_8);
                var competing=db.open();
                var blocker=competing.createStatement()){
                blocker.execute("BEGIN IMMEDIATE");
                System.setErr(capture);
                try {
                    release.countDown();
                    var failed=pending.get(8,java.util.concurrent.TimeUnit.SECONDS);
                    require(failed!=null && failed.getErrorCode()==5,
                        "R15h native create with competing SQLite writer"
                        +" reports SQLITE_BUSY code 5");
                } finally {
                    blocker.execute("ROLLBACK");
                }
            }
        } finally {
            System.setErr(originalErr);
            release.countDown();
        }
        String diagnostic=captured.toString(StandardCharsets.UTF_8);
        require(diagnostic.lines().filter(line->line.equals(
            "[game-room-yacht] start_sql_failure stage=create code=5")).count()==1,
            "R15h writer contention logs fixed create stage and SQLITE_BUSY code");
        require(!diagnostic.contains(host)
            && !diagnostic.contains(guest)
            && !diagnostic.contains(roomId),
            "R15h writer contention diagnostic excludes credentials and room ID");
        require(service.state(host).room().state()==
            io.github.playcosmos.broadcastinggameplatform.platform
                .rooms.GameRoomModels.RoomState.PLAYING
            && service.state(host).yacht()==null,
            "R15h genuine SQLite busy leaves resumable PLAYING without match");
        var recovered=service.start(host);
        require(recovered.yacht()!=null && recovered.yacht().match().phase()==
            io.github.playcosmos.broadcastinggameplatform.games.yacht
                .domain.YachtMatchState.Phase.ACTIVE,
            "R15h writer release allows host to recover ACTIVE Yacht match");
        var duplicate=service.start(host);
        require(duplicate.yacht().match().id().equals(
            recovered.yacht().match().id()),
            "R15h contention recovery reuses exactly one native match");
        try(var connection=db.open();
            var nativeCount=connection.prepareStatement(
                "SELECT COUNT(*) FROM yacht_room WHERE create_key=?");
            var linkCount=connection.prepareStatement(
                "SELECT COUNT(*) FROM game_room_yacht_link WHERE room_id=?")){
            nativeCount.setString(1,"common-yacht-"+roomId);
            linkCount.setString(1,roomId);
            try(var one=nativeCount.executeQuery();
                var two=linkCount.executeQuery()){
                require(one.next() && one.getInt(1)==1
                    && two.next() && two.getInt(1)==1,
                    "R15h real SQLite busy recovery has one match and link");
            }
        }
        System.out.println("GAME_ROOM_R15H_SQLITE_BUSY_CREATE_RECOVERY_PASSED"
            +" stage=create code=5 recovered=true match=unique");
    }


    /**
     * #123: four simultaneous real authenticated HTTP start submissions from
     * one host must all converge on the one immutable frozen player roster.
     * Sequential replay, injected SQL abort and browser manual recovery are
     * covered separately; this exercises multiple request handler threads
     * competing for the actual SQLite writer/unique native-create key.
     */
    private static void concurrentYachtStartHttpAcceptance(
        HttpClient client, URI base, GameRoomAccessService access,
        BoardGameDatabase db) throws Exception {
        var hosted=access.createHostedRoom("yacht",
            "R15h concurrent host start", "Host",
            io.github.playcosmos.broadcastinggameplatform.platform.rooms
                .GameRoomModels.SeatRole.PLAYER,2,3);
        String host=hosted.hostCredential().token();
        String roomId=hosted.room().roomId();
        String guest=access.join(access.invite(host,
            io.github.playcosmos.broadcastinggameplatform.platform.rooms
                .GameRoomModels.SeatRole.PLAYER,1,
                Duration.ofMinutes(10)).token(),"Guest").token();
        access.ready(host,true);
        access.ready(guest,true);

        var inFlight=new java.util.ArrayList<
            java.util.concurrent.CompletableFuture<HttpResponse<String>>>();
        for(int i=0;i<4;i++){
            var request=HttpRequest.newBuilder(base.resolve(ROOT+"/yacht/start"))
                .header("Accept","application/json")
                .header("Authorization","Bearer "+host)
                .header("Origin",base.toString())
                .header("Content-Type","application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build();
            inFlight.add(client.sendAsync(request,
                HttpResponse.BodyHandlers.ofString()));
        }
        java.util.concurrent.CompletableFuture.allOf(
            inFlight.toArray(new java.util.concurrent.CompletableFuture<?>[0])
        ).get(20,java.util.concurrent.TimeUnit.SECONDS);

        var matchIds=new HashSet<String>();
        for(var result:inFlight){
            var response=result.get();
            require(response.statusCode()==200,
                "R15h concurrent authenticated host start returns HTTP 200"
                    +" status="+response.statusCode());
            var match=parse(response).getAsJsonObject("yacht")
                .getAsJsonObject("match");
            require("ACTIVE".equals(match.get("phase").getAsString())
                && match.getAsJsonArray("players").size()==2,
                "R15h each concurrent start sees same ACTIVE two-player game");
            matchIds.add(match.get("id").getAsString());
        }
        require(matchIds.size()==1,
            "R15h concurrent HTTP starts resolve to a single match identity");
        var current=asState(request(client,base,ROOT+"/yacht","GET",
            null,guest,null));
        require("PLAYING".equals(current.getAsJsonObject("room")
            .get("state").getAsString())
            &&matchIds.contains(current.getAsJsonObject("yacht")
                .getAsJsonObject("match").get("id").getAsString()),
            "R15h second player reads the same durable concurrent match");

        String matchId=matchIds.iterator().next();
        try(var connection=db.open();
            var nativeCount=connection.prepareStatement(
                "SELECT COUNT(*) FROM yacht_room WHERE create_key=?");
            var linkCount=connection.prepareStatement(
                "SELECT COUNT(*) FROM game_room_yacht_link WHERE room_id=?");
            var eventCount=connection.prepareStatement(
                "SELECT COUNT(*) FROM yacht_event WHERE match_id=?")) {
            nativeCount.setString(1,"common-yacht-"+roomId);
            linkCount.setString(1,roomId);
            eventCount.setString(1,matchId);
            try(var n=nativeCount.executeQuery();
                var l=linkCount.executeQuery();
                var e=eventCount.executeQuery()) {
                require(n.next() && n.getInt(1)==1
                    && l.next() && l.getInt(1)==1
                    && e.next() && e.getInt(1)==2,
                    "R15h concurrent HTTP starts commit exactly one match,"
                        +" one binding and one pair of native start events");
            }
        }
        System.out.println("GAME_ROOM_R15H_CONCURRENT_HTTP_START_PASSED"
            +" requests=4 http=200 match=unique link=unique events=2");
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
        if(credential!=null)
            builder.header("Authorization","Bearer "+credential);
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
