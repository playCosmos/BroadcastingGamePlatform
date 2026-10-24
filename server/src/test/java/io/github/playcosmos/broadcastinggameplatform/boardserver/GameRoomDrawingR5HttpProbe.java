package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
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

/** R5 real HTTP, current-drawer secrecy, room chat/guess boundary and ACL. */
public final class GameRoomDrawingR5HttpProbe {
    private GameRoomDrawingR5HttpProbe() {}
    private static int checks;
    private static final String ROOT="/api/v1/room-membership";

    public static void main(String[] args)throws Exception {
        Path directory=Files.createTempDirectory("room-r5-http-");
        GameClientHttpServer server=null;
        try {
            Files.createDirectories(directory.resolve("web/games/drawing-guess/room"));
            Files.writeString(directory.resolve(
                "web/games/drawing-guess/room/index.html"),"R5 independent UI");
            Files.writeString(directory.resolve("web/index.html"),"R5 index");
            int adminPort=port(),clientPort=port(),wsPort=port();
            var config=new BoardServerConfig("",
                new BoardServerConfig.Server("127.0.0.1",adminPort,wsPort,false,
                    "127.0.0.1",clientPort,"",""),
                new BoardServerConfig.Storage("./data/game.db","./web","./logs"),
                new BoardServerConfig.Soop(false,30)).normalized();
            var db=new BoardGameDatabase(directory.resolve("data/game.db"));
            db.initialize();
            var access=new GameRoomAccessService(db);
            var canvas=new DrawingSyncService(db);
            var repo=new DrawingGuessRepository(db);
            var drawing=new DrawingGuessGameService(repo,canvas);
            var bridge=new GameRoomDrawingService(db,access,repo,drawing,canvas,
                (code,event)->{},source->"SOOP".equals(source.provider())
                    && "stream-a".equals(source.channelId()));
            var realtime=new GameRoomRealtimeService(db,access,(id,event)->{});
            var admin=new AdminAuthStore(db);
            admin.createSession("r5-admin-session",Instant.now().plusSeconds(1500));
            server=new GameClientHttpServer(config,directory,
                new RoomService(db),new BoardGameRuntimeEngine(db,e->{}),
                admin,new PlatformEventBus(),new ProviderRegistry(),null,
                canvas,drawing,null,access,realtime,null,bridge);
            server.start();
            var base=URI.create("http://127.0.0.1:"+clientPort);
            var client=HttpClient.newHttpClient();
            check(request(client,base,"/games/drawing-guess/room/","GET",
                null,null,null,null,null).body().contains("R5 independent UI"),
                "new room client not embedded in admin or OBS path");
            var roomBody="""
                {"gameId":"drawing_guess","name":"Room type",
                 "displayName":"Host","hostSeat":"PLAYER",
                 "maxPlayers":2,"maxRoomMembers":4}
                """;
            check(request(client,base,ROOT+"/hosted","POST",roomBody,
                null,null,null,null).statusCode()==401,
                "room cannot be created by anonymous requester");
            var created=request(client,base,ROOT+"/hosted","POST",roomBody,
                null,"BGP_ADMIN_SESSION=r5-admin-session",null,null);
            check(created.statusCode()==201,"admin creates member-backed Drawing room");
            String host=read(created).get("token").getAsString();
            String hostId=read(created).get("memberId").getAsString();
            String nativeRoomId=access.room(host).roomId();
            String grantBody="{\"roomId\":\""+nativeRoomId+
                "\",\"provider\":\"SOOP\",\"channelId\":\"stream-a\","
                +"\"expiresInSeconds\":600}";
            String grants=ROOT+"/admin/drawing/channel-grants";
            check(request(client,base,grants,"POST",grantBody,null,null,null,null)
                .statusCode()==401,"anonymous host cannot issue broadcaster grant");
            check(request(client,base,grants,"POST",grantBody,null,
                "BGP_ADMIN_SESSION=r5-admin-session",
                "https://malicious.invalid",null).statusCode()==403,
                "cross-origin issuance blocked even with an administrator session");
            var grantReply=request(client,base,grants,"POST",grantBody,null,
                "BGP_ADMIN_SESSION=r5-admin-session",null,null);
            check(request(client,base,grants,"POST",grantBody,null,
                "BGP_ADMIN_SESSION=r5-admin-session",null,null).statusCode()==409,
                "duplicate outstanding channel grant requires revocation");
            check(grantReply.statusCode()==201 &&
                grantReply.headers().firstValue("Cache-Control")
                    .orElse("").equals("no-store"),
                "grant reply is administrator only and not cacheable");
            String approval=read(grantReply).get("grant").getAsString();
            String listing=grants+"?roomId="+nativeRoomId;
            check(request(client,base,listing,"GET",null,null,null,null,null)
                .statusCode()==401,"anonymous users cannot list operator channel grants");
            var beforeGrant=request(client,base,listing,"GET",null,null,
                "BGP_ADMIN_SESSION=r5-admin-session",null,null);
            check(beforeGrant.statusCode()==200
                && beforeGrant.body().contains("PENDING")
                && !beforeGrant.body().contains(approval),
                "operator listing shows pending channel metadata, never bearer secret");
            check(request(client,base,grants+"/revoke","GET",
                null,null,"BGP_ADMIN_SESSION=r5-admin-session",null,null)
                .statusCode()!=200,"GET cannot revoke channel grants");
            var denied=request(client,base,ROOT+"/drawing/channels/add","POST",
                "{\"provider\":\"SOOP\",\"channelId\":\"stream-a\","
                +"\"grant\":\"untrusted\"}",host,null,null,null);
            check(denied.statusCode()==403,
                "host cannot claim broadcaster channel by specifying label");
            var channelBound=request(client,base,ROOT+"/drawing/channels/add",
                "POST","{\"provider\":\"SOOP\",\"channelId\":\"stream-a\","
                +"\"grant\":\""+approval+"\"}",host,null,null,null);
            check(channelBound.statusCode()==200,
                "operator-granted channel bound by authenticated host");
            check(request(client,base,ROOT+"/drawing/channels","GET",
                null,host,null,null,null).statusCode()==200,
                "authorized member may inspect public channel labels");
            var statuses=request(client,base,listing,"GET",null,null,
                "BGP_ADMIN_SESSION=r5-admin-session",null,null);
            check(statuses.statusCode()==200
                && statuses.body().contains("BOUND")
                && !statuses.body().contains(approval),
                "administrator sees active binding but not consumed bearer");
            String revokeBody="{\\"roomId\\":\\""+nativeRoomId+
                "\\",\\"provider\\":\\"SOOP\\",\\"channelId\\":\\"stream-a\\"}";
            check(request(client,base,grants+"/revoke","POST",revokeBody,
                host,null,null,null).statusCode()==401,
                "anonymous host cannot call operator revocation");
            check(request(client,base,grants+"/revoke","POST",revokeBody,
                null,"BGP_ADMIN_SESSION=r5-admin-session",
                "https://malicious.invalid",null).statusCode()==403,
                "cross-origin request cannot revoke granted channel");
            var revoked=request(client,base,grants+"/revoke","POST",revokeBody,
                null,"BGP_ADMIN_SESSION=r5-admin-session",null,null);
            check(revoked.statusCode()==200
                && !revoked.body().contains("BOUND"),
                "operator revokes live binding and pending grants atomically");
            check(request(client,base,ROOT+"/drawing/channels","GET",
                null,host,null,null,null).body().contains("\\"channels\\":[]"),
                "revoked channel disappears from host membership listing");
            check(request(client,base,grants,"POST",grantBody,null,
                "BGP_ADMIN_SESSION=r5-admin-session",null,null).statusCode()==201,
                "operator may issue fresh grant after explicit revocation");
            var playerInvite=request(client,base,ROOT+"/host/invite","POST",
                "{\"seatRole\":\"PLAYER\",\"maxUses\":1,\"expiresInSeconds\":3600}",
                host,null,null,null);
            check(playerInvite.statusCode()==201,"host can invite next drawer");
            String playerGrant=read(playerInvite).get("token").getAsString();
            var accepted=request(client,base,ROOT+"/join","POST",
                "{\"invitation\":\""+playerGrant+"\",\"displayName\":\"Second\"}",
                null,null,null,null);
            check(accepted.statusCode()==201,"second player admitted");
            String guest=read(accepted).get("token").getAsString();
            String guestId=read(accepted).get("memberId").getAsString();
            check(request(client,base,ROOT+"/me/ready","POST",
                "{\"ready\":true}",host,null,null,null).statusCode()==200,
                "host prepares");
            check(request(client,base,ROOT+"/me/ready","POST",
                "{\"ready\":true}",guest,null,null,null).statusCode()==200,
                "guest prepares");
            var begin="{\"mode\":\"ROTATING_DRAWER\",\"rounds\":2,\"durationSeconds\":120}";
            check(request(client,base,ROOT+"/drawing/start","POST",begin,
                guest,null,null,null).statusCode()==403,
                "nonhost may not initialize native game");
            var started=request(client,base,ROOT+"/drawing/start","POST",begin,
                host,null,null,null);
            check(started.statusCode()==200 && started.body().contains("ROTATING_DRAWER")
                && !started.body().contains("drawerToken"),
                "host freezes ready player order without leaking private Canvas token");
            check(request(client,base,ROOT+"/drawing/start","POST",begin,
                host,null,null,null).statusCode()==200,
                "start retries preserve same active native room");
            String createPrompt="""
                {"promptId":"http-prompt-a","answer":"apple",
                 "acceptedAnswers":["apples"]}
                """;
            check(request(client,base,ROOT+"/drawing/round","POST",createPrompt,
                guest,null,null,null).statusCode()==403,
                "wrong drawer cannot start current round");
            var first=request(client,base,ROOT+"/drawing/round","POST",createPrompt,
                host,null,null,null);
            check(first.statusCode()==200
                && !first.body().contains("apple")
                && !first.body().contains("drawerToken")
                && first.body().contains("\"canDraw\":true"),
                "round starts and publicly hides answer/canvas credentials");
            check(request(client,base,ROOT+"/drawing/my-prompt","GET",
                null,guest,null,null,null).statusCode()==403,
                "other player cannot recover current secret answer");
            check(request(client,base,ROOT+"/drawing/my-prompt","GET",
                null,host,null,null,null).body().contains("\"answer\":\"apple\""),
                "selected drawer alone can recover word after refresh");
            check(request(client,base,ROOT+"/drawing/canvas","POST",
                "{\"event\":{\"type\":\"canvas.clear\",\"payload\":{}}}",
                guest,null,null,null).statusCode()==403,
                "non-drawer cannot mutate canvas");
            var stroke=request(client,base,ROOT+"/drawing/canvas","POST",
                "{\"event\":{\"type\":\"canvas.clear\",\"payload\":{}}}",
                host,null,null,null);
            check(stroke.statusCode()==200 && stroke.body().contains("canvas.clear"),
                "authorized host canvas write persisted via HTTP");
            check(request(client,base,ROOT+"/drawing/guess","POST",
                "{\"text\":\"apple\",\"userId\":\"pretend-host\"}",
                guest,null,null,null).statusCode()==400,
                "member cannot spoof submitted provider identity");
            check(request(client,base,ROOT+"/drawing/guess","POST",
                "{\"text\":\"apple\"}",guest,null,
                "https://wrong-origin.example",null).statusCode()==403,
                "foreign-origin guess forbidden");
            var guessed=request(client,base,ROOT+"/drawing/guess","POST",
                "{\"text\":\"apple\"}",guest,null,null,null);
            check(guessed.statusCode()==200&&guessed.body().contains("\"status\":\"CORRECT\""),
                "legitimate invited player guesses correctly");
            check(request(client,base,ROOT+"/drawing/complete-round","POST","{}",
                host,null,null,null).statusCode()==200,"host completes first round");
            var nextPrompt="""
                {"promptId":"http-prompt-b","answer":"pear","acceptedAnswers":[]}
                """;
            check(request(client,base,ROOT+"/drawing/round","POST",nextPrompt,
                host,null,null,null).statusCode()==403,
                "host loses drawer role on second round");
            var second=request(client,base,ROOT+"/drawing/round","POST",nextPrompt,
                guest,null,null,null);
            check(second.statusCode()==200&&!second.body().contains("pear"),
                "second invited player starts own secret round");
            check(request(client,base,ROOT+"/drawing/my-prompt","GET",null,
                host,null,null,null).statusCode()==403,
                "former drawer cannot read next secret");
            check(request(client,base,ROOT+"/drawing/complete-round","POST","{}",
                guest,null,null,null).statusCode()==200,
                "active drawer completes current round");
            var end=request(client,base,ROOT+"/drawing/finish","POST","{}",
                host,null,null,null);
            check(end.statusCode()==200 && end.body().contains("POST_GAME"),
                "host finalizes native game and common game room");
            var other=access.createHostedRoom("drawing_guess","Separate",
                "Other",io.github.playcosmos.broadcastinggameplatform.platform.rooms
                    .GameRoomModels.SeatRole.SPECTATOR,2,3);
            check(request(client,base,ROOT+"/drawing","GET",null,
                other.hostCredential().token(),null,null,null).statusCode()==200,
                "unrelated game room remains independent");
            System.out.println("GAME_ROOM_DRAWING_HTTP_R5_PASSED checks="+checks+
                " mode=rotating auth=member-only prompt=drawer-secret"+
                " canvas=verified actorSpoof=blocked csrf=blocked"+
                " two_rounds=completed");
        } finally {
            if(server!=null)server.close();
            try(var walk=Files.walk(directory)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try{Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }
    private static JsonObject read(HttpResponse<String> response){
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }
    private static HttpResponse<String> request(HttpClient client,URI base,
        String path,String method,String body,String secret,String cookie,
        String origin,String ignored)throws Exception {
        var r=HttpRequest.newBuilder(base.resolve(path))
            .header("Accept","application/json");
        if(secret!=null)r.header("Authorization","Bearer "+secret);
        if(cookie!=null)r.header("Cookie",cookie);
        if("POST".equals(method)){
            r.header("Content-Type","application/json");
            r.header("Origin",origin==null?base.toString():origin);
            r.POST(HttpRequest.BodyPublishers.ofString(body));
        }else r.GET();
        return client.send(r.build(),HttpResponse.BodyHandlers.ofString());
    }
    private static int port()throws Exception {
        try(var socket=new ServerSocket(0)){return socket.getLocalPort();}
    }
    private static void check(boolean ok,String description){
        checks++;
        if(!ok)throw new AssertionError(description);
    }
}
