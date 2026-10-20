package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRoomService;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
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
import java.util.List;

/** Y2 boundary-level auth/Origin/public capability validation against real HTTP. */
public final class YachtHttpApiProbe {
    private static int checks;
    private YachtHttpApiProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("yacht-http-api-");
        GameClientHttpServer server = null;
        try {
            Path web = root.resolve("web");
            Path adminPage = web.resolve("admin/games/yacht/index.html");
            Files.createDirectories(adminPage.getParent());
            Files.writeString(adminPage, "<!doctype html><title>Yacht Y2</title>");
            Files.writeString(web.resolve("index.html"), "<!doctype html>");
            int adminPort = freePort(), clientPort = freePort(), wsPort = freePort();
            var config = new BoardServerConfig("", new BoardServerConfig.Server(
                "127.0.0.1", adminPort, wsPort, false, "127.0.0.1",
                clientPort, "", ""), new BoardServerConfig.Storage(
                "./data/platform.db", "./web", "./logs"),
                new BoardServerConfig.Soop(false, 30)).normalized();
            var db = new BoardGameDatabase(root.resolve("data/platform.db"));
            db.initialize();
            var auth = new AdminAuthStore(db);
            auth.createSession("yacht-admin-test", Instant.now().plusSeconds(1800));
            var yacht = new YachtRoomService(db, () -> 1, (code,json)->{});
            server = new GameClientHttpServer(
                config, root, new RoomService(db),
                new BoardGameRuntimeEngine(db, event -> {}), auth,
                new PlatformEventBus(), new ProviderRegistry(),
                null, null, null, yacht);
            server.start();
            var http = HttpClient.newHttpClient();
            URI base = URI.create("http://127.0.0.1:" + clientPort);
            String cookie = "BGP_ADMIN_SESSION=yacht-admin-test";
            String create = """
                {"requestId":"create-room-001","name":"HTTP Yacht",
                 "players":[{"id":"p1","displayName":"A"},
                            {"id":"p2","displayName":"B"}]}
                """;
            String route = "/api/v1/games/yacht/rooms";
            var unauth = send(http, base.resolve(route), null, null, "POST", create);
            require(unauth.statusCode() == 401,
                "unauthenticated Yacht room create rejected");
            var badOrigin = send(http, base.resolve(route), cookie,
                "https://attacker.invalid", "POST", create);
            require(badOrigin.statusCode() == 403,
                "foreign-origin admin mutation rejected");

            var created = send(http, base.resolve(route), cookie,
                base.toString(), "POST", create);
            require(created.statusCode() == 201, "admin can create room");
            String code = JsonParser.parseString(created.body()).getAsJsonObject()
                .get("roomCode").getAsString();
            require(code.matches("[A-HJ-NP-Z2-9]{6}"), "valid six-character code");
            var repeated = send(http, base.resolve(route), cookie,
                base.toString(), "POST", create);
            require(repeated.statusCode() == 201
                && repeated.body().contains(code),
                "repeated room-create key returns the same room");

            var publicState = send(http, base.resolve(
                "/api/v1/games/yacht/public/" + code), null, null, "GET", null);
            require(publicState.statusCode() == 200
                && publicState.body().contains("\"roomCode\":\""+code+"\"")
                && !publicState.body().contains("yacht-admin-test"),
                "capability-code public snapshot contains no admin secrets");
            var publicEvents = send(http, base.resolve(
                "/api/v1/games/yacht/public/" + code + "/events?since=-1"),
                null, null, "GET", null);
            require(publicEvents.statusCode() == 200
                && publicEvents.body().contains("\"sequence\":0"),
                "public observers can recover committed event 0");
            require(send(http, base.resolve("/api/v1/games/yacht/public/INVALID"),
                null,null,"GET",null).statusCode() == 404,
                "unknown public codes rejected");
            require(send(http, base.resolve("/api/v1/games/yacht/public/" + code
                + "/events?since=NaN"), null,null,"GET",null).statusCode() == 400,
                "invalid replay cursors rejected");

            var pageUnauthorized = send(http, base.resolve("/admin/games/yacht/"),
                null,null,"GET",null);
            require(pageUnauthorized.statusCode() == 401,
                "anonymous users cannot open Yacht operator page");
            require(send(http, base.resolve("/admin/games/yacht/"),cookie,
                null,"GET",null).statusCode() == 200,
                "authenticated operator can open packaged Yacht admin page");

            String mutation = "/api/v1/games/yacht/rooms/" + code + "/";
            var activate = send(http, base.resolve(mutation + "activate"), cookie,
                base.toString(), "POST", """
                    {"commandId":"activate-001","expectedVersion":0}
                    """);
            require(activate.statusCode() == 200
                && activate.body().contains("\"version\":1"),
                "authenticated activate transitions to version 1");
            var blocked = send(http, base.resolve(mutation+"roll"), null, null,
                "POST", "{\"commandId\":\"roll00001\",\"expectedVersion\":1}");
            require(blocked.statusCode() == 401,
                "unauthenticated dice roll denied");
            var injection = send(http, base.resolve(mutation+"roll"),cookie,
                base.toString(),"POST","""
                    {"commandId":"roll00001","expectedVersion":1,
                     "dice":[6,6,6,6,6]}
                    """);
            require(injection.statusCode() == 400,
                "client-supplied dice payload rejected");
            var rolled = send(http, base.resolve(mutation+"roll"),cookie,
                base.toString(),"POST",
                "{\"commandId\":\"roll00001\",\"expectedVersion\":1}");
            require(rolled.statusCode() == 200
                && rolled.body().contains("\"dice\":[1,1,1,1,1]"),
                "server RNG generates actual dice");
            var rollRepeat = send(http, base.resolve(mutation+"roll"),cookie,
                base.toString(),"POST",
                "{\"commandId\":\"roll00001\",\"expectedVersion\":1}");
            require(rollRepeat.statusCode() == 200
                && rolled.body().equals(rollRepeat.body()),
                "same command ID returns original committed HTTP response");
            var stale = send(http, base.resolve(mutation+"roll"),cookie,
                base.toString(),"POST",
                "{\"commandId\":\"roll00002\",\"expectedVersion\":1}");
            require(stale.statusCode() == 409, "stale roll returns 409 conflict");
            var score = send(http, base.resolve(mutation+"score"),cookie,
                base.toString(),"POST",
                "{\"commandId\":\"score0001\",\"expectedVersion\":2,\"category\":\"yacht\"}");
            require(score.statusCode() == 200
                && score.body().contains("\"completedTurns\":1")
                && score.body().contains("\"YACHT\":50"),
                "HTTP score commits real five-of-kind as 50 points");
            var events = send(http, base.resolve(mutation+"events?since=1"),cookie,
                null,"GET",null);
            require(events.statusCode() == 200
                && events.body().contains("\"sequence\":2")
                && events.body().contains("\"sequence\":3"),
                "admin REST replay preserves version event sequence");
            var close = send(http, base.resolve(mutation+"close"),cookie,
                base.toString(),"POST",
                "{\"commandId\":\"close0001\",\"expectedVersion\":3}");
            require(close.statusCode() == 200
                && close.body().contains("\"phase\":\"CLOSED\""),
                "operator can close and persist Yacht room");
            require(yacht.state(code).match().phase()
                == io.github.playcosmos.broadcastinggameplatform.games.yacht.domain
                    .YachtMatchState.Phase.CLOSED,
                "HTTP command changed authoritative DB state");
            System.out.println("YACHT_HTTP_Y2_PASSED checks=" + checks
                + " auth=true origin=true public_read=true"
                + " idempotency=true replay=true dice_injection=blocked");
        } finally {
            if (server != null) server.close();
            try (var walk = Files.walk(root)) {
                walk.sorted((a,b)->b.compareTo(a)).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) {}
                });
            }
        }
    }

    private static HttpResponse<String> send(
        HttpClient client, URI uri, String cookie, String origin,
        String method, String body) throws Exception {
        var request = HttpRequest.newBuilder(uri)
            .header("Accept", "application/json");
        if (cookie != null) request.header("Cookie", cookie);
        if (origin != null) request.header("Origin", origin);
        if ("POST".equals(method)) {
            request.header("Content-Type","application/json");
            request.POST(HttpRequest.BodyPublishers.ofString(body));
        } else request.GET();
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static int freePort() throws Exception {
        try (var sock = new ServerSocket(0)) { return sock.getLocalPort(); }
    }
    private static void require(boolean valid, String detail) {
        checks++;
        if (!valid) throw new AssertionError(detail);
    }
}
