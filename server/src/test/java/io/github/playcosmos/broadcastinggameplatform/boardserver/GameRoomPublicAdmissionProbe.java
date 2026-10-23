package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
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

/** Guest/public entry acceptance against actual HTTP, migrated SQLite. */
public final class GameRoomPublicAdmissionProbe {
    private GameRoomPublicAdmissionProbe(){}
    private static int checks;
    private static final String API="/api/v1/room-membership";

    public static void main(String[] args)throws Exception {
        Path root=Files.createTempDirectory("room-public-");
        GameClientHttpServer server=null;
        try {
            Files.createDirectories(root.resolve("web"));
            Files.writeString(root.resolve("web/index.html"),"gamecenter public");
            int adminPort=port(),httpPort=port(),wsPort=port();
            var config=new BoardServerConfig("",
                new BoardServerConfig.Server("127.0.0.1",adminPort,wsPort,
                    false,"127.0.0.1",httpPort,"",""),
                new BoardServerConfig.Storage("./data/game.db","./web","./logs"),
                new BoardServerConfig.Soop(false,30)).normalized();
            var database=new BoardGameDatabase(root.resolve("data/game.db"));
            database.initialize();
            var auth=new AdminAuthStore(database);
            auth.createSession("admin-public-test",Instant.now().plusSeconds(1200));
            var members=new GameRoomAccessService(database);
            server=new GameClientHttpServer(config,root,new RoomService(database),
                new BoardGameRuntimeEngine(database,event->{}),auth,
                new PlatformEventBus(),new ProviderRegistry(),
                null,null,null,null,members);
            server.start();
            var client=HttpClient.newHttpClient();
            URI base=URI.create("http://127.0.0.1:"+httpPort);
            String create= """
                {"gameId":"drawing_guess","name":"Guests only",
                 "displayName":"Guest host","hostSeat":"PLAYER",
                 "maxPlayers":2,"maxRoomMembers":3}
                """;
            String privateCreate= """
                {"gameId":"drawing_guess","name":"Private legacy",
                 "displayName":"Admin host","hostSeat":"PLAYER",
                 "maxPlayers":2,"maxRoomMembers":3}
                """;
            var privateRoom=send(client,base,API+"/hosted","POST",
                privateCreate,base.toString(),"BGP_ADMIN_SESSION=admin-public-test",null);
            check(privateRoom.statusCode()==201,"legacy admin invitation-only room retained");
            String privateCode=json(privateRoom).getAsJsonObject("room")
                .get("roomCode").getAsString();
            var directory=send(client,base,API+"/public/rooms?gameId=drawing_guess",
                "GET",null,null,null,null);
            check(directory.statusCode()==200
                && !directory.body().contains(privateCode)
                && !directory.body().contains("Private legacy"),
                "admin-created rooms excluded from public directory");
            check(send(client,base,API+"/public/join","POST",
                join(privateCode,"Attacker","PLAYER"),base.toString(),null,null)
                .statusCode()==404,"private room cannot be bypassed by public code");

            check(send(client,base,API+"/public/hosted","POST",
                create,null,null,null).statusCode()==403,
                "guest hosting still requires same-origin write");
            check(send(client,base,API+"/public/hosted","POST",
                create,"https://attacker.invalid",null,null).statusCode()==403,
                "hostile origin cannot create public rooms");
            check(send(client,base,API+"/public/hosted","POST",
                create,base.toString(),null,null).statusCode()==201,
                "anonymous user hosts same game without admin session");
            // A second public room with a known bearer is used for exact assertions.
            var hosted=send(client,base,API+"/public/hosted","POST",
                create,base.toString(),null,null);
            check(hosted.statusCode()==201,
                "guest host can create publicly discoverable room");
            JsonObject owner=json(hosted);
            String host=owner.get("token").getAsString();
            String code=owner.getAsJsonObject("room").get("roomCode").getAsString();
            String roomId=owner.getAsJsonObject("room").get("roomId").getAsString();
            check(host.length()==43 && !hosted.body().contains("actorId")
                && !hosted.body().contains("session_hash"),
                "public host receives same scoped secret but no internal actor ID");
            check(send(client,base,API+"/me","GET",null,null,null,host)
                .body().contains("\"isHost\":true"),
                "guest-created room host gets full authenticated moderator role");
            var listing=send(client,base,API+"/public/rooms?gameId=drawing_guess",
                "GET",null,null,null,null);
            check(listing.statusCode()==200 && listing.body().contains(code)
                && !listing.body().contains(host)
                && !listing.body().contains("actorId")
                && !listing.body().contains(privateCode)
                && !listing.body().contains("memberId"),
                "public directory includes public code only, no member identities");

            check(send(client,base,API+"/public/join","POST",
                join(code,"First","PLAYER"),"https://attacker.invalid",null,null)
                .statusCode()==403,"same-origin required for public join");
            var player=send(client,base,API+"/public/join","POST",
                join(code,"First","PLAYER"),base.toString(),null,null);
            check(player.statusCode()==201,"anonymous joins as full PLAYER");
            String playerToken=json(player).get("token").getAsString();
            check(json(player).getAsJsonObject("room").get("playerCount").getAsInt()==2,
                "host + admitted guest occupy both player seats");
            check(send(client,base,API+"/public/join","POST",
                join(code,"Overflow","PLAYER"),base.toString(),null,null)
                .statusCode()==409,"public player quota protected");
            var viewer=send(client,base,API+"/public/join","POST",
                join(code,"Audience","SPECTATOR"),base.toString(),null,null);
            check(viewer.statusCode()==201
                && json(viewer).getAsJsonObject("room").get("memberCount").getAsInt()==3,
                "spectator consumes total room capacity but no player seat");
            String spectatorToken=json(viewer).get("token").getAsString();
            check(send(client,base,API+"/public/join","POST",
                join(code,"Overflow spectator","SPECTATOR"),base.toString(),null,null)
                .statusCode()==409,"public total room quota protected");
            check(send(client,base,API+"/public/join","POST",
                join(code,"Wrong game","SPECTATOR").replace(
                    "drawing_guess","yacht"),base.toString(),null,null)
                .statusCode()==404,"room codes cannot cross game namespace");
            check(send(client,base,API+"/me","GET",null,null,null,spectatorToken)
                .statusCode()==200,
                "spectator receives full member authenticated services");
            check(send(client,base,API+"/me","GET",null,null,null,playerToken)
                .statusCode()==200,
                "player receives full member authenticated services");

            String playerId=json(player).get("memberId").getAsString();
            var kicked=send(client,base,API+"/host/kick","POST",
                "{\"memberId\":\""+playerId+"\"}",base.toString(),null,host);
            check(kicked.statusCode()==200,"guest room host can kick member");
            check(send(client,base,API+"/me","GET",null,null,null,playerToken)
                .statusCode()==403,"kicked guest credential immediately revoked");
            check(send(client,base,API+"/public/join","POST",
                join(code,"Different anonymous session","PLAYER"),
                base.toString(),null,null).statusCode()==201,
                "public admission remains open after kick: no false same-person ban");

            // Third public-hosted attempt is rate-limited. The two completed
            // hosts above exhausted 2 of 3, so third succeeds and fourth fails.
            var third=send(client,base,API+"/public/hosted","POST",
                create,base.toString(),null,null);
            check(third.statusCode()==201,"third guest host within rate budget");
            var limited=send(client,base,API+"/public/hosted","POST",
                create,base.toString(),null,null);
            check(limited.statusCode()==429 &&
                limited.headers().firstValue("Retry-After").isPresent(),
                "fourth host request limited per remote within 10m");
            check(send(client,base,API+"/public/rooms?gameId=invalid",
                "GET",null,null,null,null).statusCode()==400,
                "directory game filter validates known game IDs");

            // Scope remains opt-in even after DB restart.
            var fresh=new GameRoomAccessService(
                new BoardGameDatabase(root.resolve("data/game.db")));
            check(fresh.publicRooms("drawing_guess").stream()
                .anyMatch(p->p.roomCode().equals(code)),
                "public listing survives SQLite service restart");
            check(fresh.publicRooms("drawing_guess").stream()
                .noneMatch(p->p.roomCode().equals(privateCode)),
                "private room remains hidden after SQLite restart");
            check(send(client,base,API+"/host/close","POST","{}",
                base.toString(),null,spectatorToken).statusCode()==403,
                "non-host cannot close a public game room");
            check(send(client,base,API+"/host/close","POST","{}",
                "https://attacker.invalid",null,host).statusCode()==403,
                "cross-origin host closure denied");
            var ticket=send(client,base,API+"/host/invite","POST",
                "{\"seatRole\":\"PLAYER\",\"maxUses\":1,\"expiresInSeconds\":3600}",
                base.toString(),null,host);
            check(ticket.statusCode()==201,"host can issue invite before closing");
            String closeInvite=json(ticket).get("token").getAsString();
            var closeResult=send(client,base,API+"/host/close","POST","{}",
                base.toString(),null,host);
            check(closeResult.statusCode()==200
                && closeResult.body().contains("\"state\":\"CLOSED\"")
                && closeResult.body().contains("\"memberCount\":0"),
                "host close atomically empties room and marks CLOSED");
            check(send(client,base,API+"/me","GET",null,null,null,host)
                .statusCode()==403
                && send(client,base,API+"/me","GET",null,null,null,spectatorToken)
                    .statusCode()==403,
                "public host and spectator bearers both revoked");
            check(send(client,base,API+"/join","POST",
                "{\"invitation\":\""+closeInvite+"\",\"displayName\":\"late\"}",
                base.toString(),null,null).statusCode()==403,
                "host closure revokes previously issued invitations");
            check(send(client,base,API+"/public/join","POST",
                join(code,"Late visitor","SPECTATOR"),base.toString(),null,null)
                .statusCode()==409,
                "closed public room denies new code admission");
            check(!send(client,base,API+"/public/rooms?gameId=drawing_guess",
                "GET",null,null,null,null).body().contains(code),
                "closed public room is removed from discovery");
            check(send(client,base,API+"/me","GET",null,null,null,
                json(privateRoom).get("token").getAsString()).statusCode()==200,
                "unrelated private room remains usable after public close");

            System.out.println("GAME_ROOM_PUBLIC_ADMISSION_PASSED checks="+checks+
                " guest_host=equal public_directory=private_hidden"+
                " direct_join=role_and_capacity_checked kick=revoked"+
                " origin=verified rate_limited=true restart=sqlite");
        } finally {
            if(server!=null)server.close();
            try(var walk=Files.walk(root)) {
                walk.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try{Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }
    private static String join(String code,String name,String role){
        return "{\"gameId\":\"drawing_guess\",\"roomCode\":\""+code+
            "\",\"displayName\":\""+name+"\",\"seatRole\":\""+role+"\"}";
    }
    private static JsonObject json(HttpResponse<String> response){
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }
    private static HttpResponse<String> send(HttpClient client,URI base,
        String path,String method,String body,String origin,
        String cookie,String token)throws Exception {
        var request=HttpRequest.newBuilder(base.resolve(path))
            .header("Accept","application/json");
        if(origin!=null)request.header("Origin",origin);
        if(cookie!=null)request.header("Cookie",cookie);
        if(token!=null)request.header("Authorization","Bearer "+token);
        if("POST".equals(method)){
            request.header("Content-Type","application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body));
        }else request.GET();
        return client.send(request.build(),HttpResponse.BodyHandlers.ofString());
    }
    private static int port()throws Exception{
        try(var socket=new ServerSocket(0)){return socket.getLocalPort();}
    }
    private static void check(boolean okay,String message){
        checks++;
        if(!okay)throw new AssertionError(message);
    }
}
