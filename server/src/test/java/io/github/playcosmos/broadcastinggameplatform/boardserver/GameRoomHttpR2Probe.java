package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService;
import io.github.playcosmos.broadcastinggameplatform.room.BoardGameRuntimeEngine;
import io.github.playcosmos.broadcastinggameplatform.room.RoomService;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

/** Real network R2 auth / invitation / privilege-change security probe. */
public final class GameRoomHttpR2Probe {
    private GameRoomHttpR2Probe() {}
    private static int checks;

    public static void main(String[] args) throws Exception {
        Path root=Files.createTempDirectory("game-room-http-r2-");
        GameClientHttpServer server=null;
        try{
            Path web=root.resolve("web");
            Files.createDirectories(web);
            Files.writeString(web.resolve("index.html"),"<html>Game room</html>");
            int a=port(), p=port(), w=port();
            var config=new BoardServerConfig("",new BoardServerConfig.Server(
                "127.0.0.1",a,w,false,"127.0.0.1",p,"",""),
                new BoardServerConfig.Storage("./data/platform.db","./web","./logs"),
                new BoardServerConfig.Soop(false,30)).normalized();
            var db=new BoardGameDatabase(root.resolve("data/platform.db"));
            db.initialize();
            var auth=new AdminAuthStore(db);
            auth.createSession("room-admin-fixture",Instant.now().plusSeconds(1800));
            var access=new GameRoomAccessService(db);
            server=new GameClientHttpServer(config,root,new RoomService(db),
                new BoardGameRuntimeEngine(db,event->{}),auth,
                new PlatformEventBus(),new ProviderRegistry(),
                null,null,null,null,access);
            server.start();
            URI base=URI.create("http://127.0.0.1:"+p);
            var http=HttpClient.newHttpClient();
            String endpoint="/api/v1/room-membership";
            String cookie="BGP_ADMIN_SESSION=room-admin-fixture";
            String create="""
                {"gameId":"yacht","name":"HTTP membership","displayName":"Host",
                 "hostSeat":"PLAYER","maxPlayers":2,"maxRoomMembers":3}
                """;
            check(send(http,base.resolve(endpoint+"/hosted"),"POST",create,
                null,null,null).statusCode()==403,
                "room creation must reject missing browser Origin");
            check(send(http,base.resolve(endpoint+"/hosted"),"POST",create,
                "https://untrusted.invalid",cookie,null).statusCode()==403,
                "admin cannot create from foreign origin");
            check(send(http,base.resolve(endpoint+"/hosted"),"POST",create,
                base.toString(),null,null).statusCode()==401,
                "only authenticated administrator may bootstrap host");
            var created=send(http,base.resolve(endpoint+"/hosted"),"POST",create,
                base.toString(),cookie,null);
            check(created.statusCode()==201,"admin creates room and host credential");
            var createdJson=JsonParser.parseString(created.body()).getAsJsonObject();
            String host=createdJson.get("token").getAsString();
            check(host.length()==43
                && created.body().contains("\"roomCode\"")
                && !created.body().contains("actorId")
                && !created.body().contains("session_hash"),
                "public projection must omit actor IDs and DB hashes");

            check(send(http,base.resolve(endpoint+"/me"),"GET",null,null,null,null)
                .statusCode()==403,"member read needs bearer token");
            var me=send(http,base.resolve(endpoint+"/me"),"GET",null,null,null,host);
            check(me.statusCode()==200
                && me.body().contains("\"isHost\":true"),
                "host bearer auth accepted without admin cookie");
            String inviteBody="""
                {"seatRole":"PLAYER","maxUses":1,"expiresInSeconds":3600}
                """;
            check(send(http,base.resolve(endpoint+"/host/invite"),"POST",
                inviteBody,base.toString(),null,null).statusCode()==403,
                "invite requires member token");
            var invite=send(http,base.resolve(endpoint+"/host/invite"),"POST",
                inviteBody,base.toString(),null,host);
            check(invite.statusCode()==201,"host can issue player invite");
            String grant=JsonParser.parseString(invite.body()).getAsJsonObject()
                .get("token").getAsString();
            check(send(http,base.resolve(endpoint+"/join"),"POST",
                "{\"invitation\":\""+grant+"\",\"displayName\":\"Visitor\"}",
                "https://untrusted.invalid",null,null).statusCode()==403,
                "cross-origin invitation exchange denied");
            var joined=send(http,base.resolve(endpoint+"/join"),"POST",
                "{\"invitation\":\""+grant+"\",\"displayName\":\"Visitor\"}",
                base.toString(),null,null);
            check(joined.statusCode()==201,"invite-only guest admission");
            var guestJson=JsonParser.parseString(joined.body()).getAsJsonObject();
            String guest=guestJson.get("token").getAsString();
            String guestId=guestJson.get("memberId").getAsString();
            check(!guest.equals(host)
                && guestJson.getAsJsonObject("room").get("playerCount").getAsInt()==2
                && guestJson.getAsJsonObject("room").get("memberCount").getAsInt()==2,
                "guest gets distinct scoped token and exactly one seat");
            check(send(http,base.resolve(endpoint+"/join"),"POST",
                "{\"invitation\":\""+grant+"\",\"displayName\":\"Replay\"}",
                base.toString(),null,null).statusCode()==403,
                "consumed invite cannot be used twice");
            check(send(http,base.resolve(endpoint+"/host/invite"),"POST",
                inviteBody,base.toString(),null,guest).statusCode()==403,
                "nonhost cannot issue invitations");
            check(send(http,base.resolve(endpoint+"/me/ready"),"POST",
                "{\"ready\":true}",base.toString(),null,guest).statusCode()==200,
                "authorized player may ready");

            var transferred=send(http,base.resolve(endpoint+"/host/transfer"),"POST",
                "{\"memberId\":\""+guestId+"\"}",base.toString(),null,host);
            check(transferred.statusCode()==200
                && transferred.body().contains("\"isHost\":true"),
                "host ownership delegated to existing player");
            check(send(http,base.resolve(endpoint+"/host/invite"),"POST",
                inviteBody,base.toString(),null,host).statusCode()==403,
                "old host cannot continue admin actions after transfer");
            var spectator=send(http,base.resolve(endpoint+"/host/invite"),"POST",
                "{\"seatRole\":\"SPECTATOR\",\"maxUses\":1,\"expiresInSeconds\":60}",
                base.toString(),null,guest);
            check(spectator.statusCode()==201,
                "new host immediately gains moderation capability");
            String viewerInvite=JsonParser.parseString(spectator.body())
                .getAsJsonObject().get("token").getAsString();
            var viewer=send(http,base.resolve(endpoint+"/join"),"POST",
                "{\"invitation\":\""+viewerInvite+"\",\"displayName\":\"Viewer\"}",
                base.toString(),null,null);
            check(viewer.statusCode()==201
                && viewer.body().contains("\"memberCount\":3"),
                "spectator fills total member capacity independent of player seats");
            var viewerJson=JsonParser.parseString(viewer.body()).getAsJsonObject();
            String viewerToken=viewerJson.get("token").getAsString();
            String viewerId=viewerJson.get("memberId").getAsString();
            check(send(http,base.resolve(endpoint+"/me/ready"),"POST",
                "{\"ready\":true}",base.toString(),null,viewerToken).statusCode()==403,
                "spectator cannot set player-ready status");
            check(send(http,base.resolve(endpoint+"/host/kick"),"POST",
                "{\"memberId\":\""+viewerId+"\"}",base.toString(),null,guest)
                .statusCode()==200,"host may kick spectator");
            check(send(http,base.resolve(endpoint+"/me"),"GET",null,
                null,null,viewerToken).statusCode()==403,
                "kicked user cannot authenticate with old token");
            check(send(http,base.resolve(endpoint+"/me/rotate"),"POST",
                "{}",base.toString(),null,host).statusCode()==200,
                "former host may still rotate own member credential");
            check(send(http,base.resolve(endpoint+"/host/kick"),"POST",
                "{\"memberId\":\""+guestId+"\"}",base.toString(),null,host)
                .statusCode()==403,"former host cannot kick successor");

            System.out.println("GAME_ROOM_HTTP_R2_PASSED checks="+checks
                +" admin_guard=true same_origin=true bearer_scoped=true"
                +" invite_once=true host_transfer=true kick_revoked=true"
                +" identities_hidden=true");
        }finally{
            if(server!=null)server.close();
            try(var walk=Files.walk(root)){
                walk.sorted((x,y)->y.compareTo(x)).forEach(path->{
                    try{Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }

    private static HttpResponse<String> send(HttpClient client,URI uri,String method,
        String body,String origin,String cookie,String token)throws Exception {
        var b=HttpRequest.newBuilder(uri).header("Accept","application/json");
        if(origin!=null)b.header("Origin",origin);
        if(cookie!=null)b.header("Cookie",cookie);
        if(token!=null)b.header("Authorization","Bearer "+token);
        if("POST".equals(method)){
            b.header("Content-Type","application/json")
             .POST(HttpRequest.BodyPublishers.ofString(body));
        }else b.GET();
        return client.send(b.build(),HttpResponse.BodyHandlers.ofString());
    }

    private static int port()throws Exception{
        try(var server=new ServerSocket(0)){return server.getLocalPort();}
    }
    private static void check(boolean okay,String details){
        checks++;
        if(!okay)throw new AssertionError(details);
    }
}
