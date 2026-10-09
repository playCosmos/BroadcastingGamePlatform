package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.room.BoardGameRuntimeEngine;
import io.github.playcosmos.broadcastinggameplatform.room.RoomService;
import io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw.ViewerDrawService;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static io.github.playcosmos.broadcastinggameplatform.room.RoomModels.*;

public final class ClientBoundaryProbe {
    private ClientBoundaryProbe() {}

    public static void main(String[] args) {
        System.exit(run());
    }

    public static int run() {
        Path root = null;
        GameClientHttpServer server = null;
        HttpServer mockAdmin = null;
        try {
            root = Files.createTempDirectory(
                "games-client-boundary-"
            );
            Path webRoot = root.resolve("web");
            Path boardRoot = webRoot.resolve("games/board");
            Files.createDirectories(boardRoot);
            Files.writeString(
                boardRoot.resolve("index.html"),
                "<!doctype html><title>board client</title>",
                StandardCharsets.UTF_8
            );
            Files.writeString(
                webRoot.resolve("index.html"),
                "<!doctype html><title>platform</title>",
                StandardCharsets.UTF_8
            );
            Path adminRoot = webRoot.resolve("admin");
            Files.createDirectories(adminRoot);
            Files.writeString(
                adminRoot.resolve("index.html"),
                "<!doctype html><title>platform admin</title>",
                StandardCharsets.UTF_8
            );
            Path boardAdminRoot = adminRoot.resolve("games/board");
            Files.createDirectories(boardAdminRoot);
            Files.writeString(
                boardAdminRoot.resolve("index.html"),
                "<!doctype html><title>board room creator</title>",
                StandardCharsets.UTF_8
            );

            int adminPort = freePort();
            int clientPort = freePort();
            int websocketPort = freePort();

            mockAdmin = HttpServer.create(
                new InetSocketAddress("127.0.0.1", adminPort),
                0
            );
            mockAdmin.createContext("/", exchange -> {
                String path = exchange.getRequestURI().getPath();
                byte[] body;
                int status;

                if ("/api/state".equals(path)) {
                    status = 200;
                    body = "{\"source\":\"local-admin\"}"
                        .getBytes(StandardCharsets.UTF_8);
                } else if (
                    path.startsWith("/api/board/rooms")
                    && "POST".equalsIgnoreCase(
                        exchange.getRequestMethod()
                    )
                ) {
                    status = 200;
                    body = "{\"proxied\":true}"
                        .getBytes(StandardCharsets.UTF_8);
                } else {
                    status = 404;
                    body = "{\"error\":\"not found\"}"
                        .getBytes(StandardCharsets.UTF_8);
                }

                exchange.getResponseHeaders().set(
                    "Content-Type",
                    "application/json; charset=utf-8"
                );
                exchange.sendResponseHeaders(status, body.length);
                try (var output = exchange.getResponseBody()) {
                    output.write(body);
                }
            });
            mockAdmin.start();

            var config = new BoardServerConfig(
                "",
                new BoardServerConfig.Server(
                    "127.0.0.1",
                    adminPort,
                    websocketPort,
                    false,
                    "127.0.0.1",
                    clientPort,
                    "",
                    ""
                ),
                new BoardServerConfig.Storage(
                    "./data/board-game.db",
                    "./web",
                    "./logs"
                ),
                new BoardServerConfig.Soop(false, 30)
            ).normalized();

            var database = new BoardGameDatabase(
                root.resolve("data/board-game.db")
            );
            database.initialize();
            var rooms = new RoomService(
                database,
                players -> players
            );
            var runtime = new BoardGameRuntimeEngine(
                database,
                event -> {}
            );

            var adminAuthStore = new AdminAuthStore(database);
            var viewerDraw = new ViewerDrawService(database);
            var drawingSync = new DrawingSyncService();
            var drawingRepository =
                new DrawingGuessRepository(database);
            var drawingGame = new DrawingGuessGameService(
                drawingRepository,
                drawingSync
            );
            server = new GameClientHttpServer(
                config,
                root,
                rooms,
                runtime,
                adminAuthStore,
                new PlatformEventBus(),
                new ProviderRegistry(),
                viewerDraw,
                drawingSync,
                drawingGame
            );
            server.start();
            require(
                server.localAdminBootstrapUrl().startsWith(
                    "http://127.0.0.1:" + clientPort + "/admin/?token="
                ),
                "local user-facing admin URL must use client port"
            );

            var client = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
            URI base = URI.create(
                "http://127.0.0.1:" + clientPort
            );

            var roomRequest = new CreateRoomRequest(
                "Room Code Boundary",
                List.of(new PlayerInput("soop-a", "A", null, 100)),
                new BoardInput("dimensions", 8, 6, null, "rounded"),
                new MovementInput("dice", 1, false, false, false),
                new RulesInput("destinationOnly", true, true),
                List.of(),
                new RandomPoolInput("custom", List.of(), null)
            );
            var draftRoom = rooms.create(roomRequest);
            String roomCode = draftRoom.roomId();
            require(
                roomCode.length() == 6,
                "room code must be six characters"
            );

            var draftCodeRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/board/rooms/" + roomCode
                            + "?roomCode=" + roomCode
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                draftCodeRead.statusCode() == 401,
                "draft room code must not authorize public overlay reads"
            );

            rooms.commitPreview(roomCode);

            var missingCodeRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/board/rooms/" + roomCode)
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                missingCodeRead.statusCode() == 401,
                "public room read must require the six-character room code"
            );

            String wrongRoomCode = roomCode.equals("AAAAAA")
                ? "BBBBBB"
                : "AAAAAA";
            var wrongCodeRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/board/rooms/" + roomCode
                            + "?roomCode=" + wrongRoomCode
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                wrongCodeRead.statusCode() == 401,
                "wrong room code must not authorize public overlay reads"
            );

            var roomCodeRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/board/rooms/" + roomCode
                            + "?roomCode=" + roomCode
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                roomCodeRead.statusCode() == 200
                    && roomCodeRead.body().contains(
                        "\"roomId\":\"" + roomCode + "\""
                    ),
                "committed room code must authorize room snapshot reads"
            );
            require(
                roomCodeRead.body().contains("\"playerId\":\"P1\"")
                    && !roomCodeRead.body().contains("\"soopId\"")
                    && !roomCodeRead.body().contains("\"provider\"")
                    && !roomCodeRead.body().contains(
                        "\"balloonTrigger\""
                    ),
                "public room snapshot must hide provider identities"
            );

            var runtimeCodeRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/board/rooms/" + roomCode
                            + "/runtime?roomCode=" + roomCode
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                runtimeCodeRead.statusCode() == 200
                    && runtimeCodeRead.body().contains(
                        "\"roomId\":\"" + roomCode + "\""
                    ),
                "committed room code must authorize runtime reads"
            );
            require(
                runtimeCodeRead.body().contains(
                    "\"playerId\":\"P1\""
                )
                    && !runtimeCodeRead.body().contains("\"soopId\""),
                "public runtime snapshot must use anonymous player keys"
            );

            var landingResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/")
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                landingResponse.statusCode() == 200
                    && landingResponse.body().contains("platform"),
                "platform landing must be public"
            );

            var platformApiResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/v1/platform")
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                platformApiResponse.statusCode() == 200
                    && platformApiResponse.body().contains(
                        "\"BroadcastingGamePlatform\""
                    )
                    && platformApiResponse.body().contains(
                        "\"board\""
                    ),
                "platform API must expose the board module"
            );

            var boardResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/games/board/index.html")
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                boardResponse.statusCode() == 200,
                "board client asset must be public"
            );

            require(
                GameClientHttpServer.isTrustedForwardProxy(
                    new InetSocketAddress("127.0.0.1", 12345)
                ),
                "loopback reverse proxy must be trusted"
            );
            require(
                !GameClientHttpServer.isTrustedForwardProxy(
                    new InetSocketAddress("203.0.113.10", 12345)
                ),
                "external clients must not be trusted as reverse proxies"
            );

            require(
                GameClientHttpServer.safeQueryDecode("%ZZ") == null,
                "malformed query encoding must be rejected safely"
            );
            require(
                "room code".equals(
                    GameClientHttpServer.safeQueryDecode("room+code")
                ),
                "valid query encoding must still decode normally"
            );

            var configResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/client/config")
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                configResponse.statusCode() == 200,
                "client config must be public"
            );
            require(
                configResponse.body().contains(
                    "\"websocketUrl\":\"ws://127.0.0.1:"
                        + websocketPort
                ),
                "client config must expose websocket URL"
            );

            var hiddenAdminResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/board-admin.html")
                ).GET().build(),
                HttpResponse.BodyHandlers.discarding()
            );
            require(
                hiddenAdminResponse.statusCode() == 404,
                "raw admin page must not be exposed"
            );

            var unauthenticatedAdminPage = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/admin/")
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                unauthenticatedAdminPage.statusCode() == 401,
                "admin path must require authentication"
            );
            require(
                unauthenticatedAdminPage.body().contains("name=\"token\"")
                    && unauthenticatedAdminPage.body().contains(
                        "requestApproval"
                    ),
                "admin authentication page must offer token entry and approval request"
            );

            var unauthenticatedBoardCreator = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/admin/games/board/")
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                unauthenticatedBoardCreator.statusCode() == 401
                    && unauthenticatedBoardCreator.body().contains(
                        "action=\"/admin/games/board/\""
                    ),
                "board creator authentication must preserve requested route"
            );

            var unauthenticatedPost = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/board/rooms")
                )
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                unauthenticatedPost.statusCode() == 401,
                "room mutation must require admin session"
            );

            var unauthenticatedViewerDraw = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/v1/tools/viewer-draw/sessions")
                )
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    "{\"mode\":\"NUMBER\",\"config\":{\"maxNumber\":45,\"drawCount\":7}}"
                ))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                unauthenticatedViewerDraw.statusCode() == 401,
                "viewer draw creation must require admin session"
            );

            var unauthenticatedMachineMap = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/v1/tools/viewer-draw/maps")
                )
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                unauthenticatedMachineMap.statusCode() == 401,
                "machine map mutation must require admin session"
            );

            var unauthenticatedDrawingSession = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/games/drawing-guess/prototype/session"
                    )
                )
                .POST(HttpRequest.BodyPublishers.noBody())
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                unauthenticatedDrawingSession.statusCode() == 401,
                "drawing sync creation must require admin session"
            );

            URI bootstrapUri = URI.create(server.adminBootstrapUrl());
            var bootstrapResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/admin/games/board/?"
                            + bootstrapUri.getRawQuery()
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.discarding()
            );
            require(
                bootstrapResponse.statusCode() == 303,
                "bootstrap token must redirect after authentication"
            );
            require(
                "/admin/games/board/".equals(
                    bootstrapResponse.headers()
                        .firstValue("Location")
                        .orElse("")
                ),
                "bootstrap authentication must return to board creator"
            );

            String setCookie = bootstrapResponse.headers()
                .firstValue("Set-Cookie")
                .orElseThrow(() -> new IllegalStateException(
                    "admin session cookie missing"
                ));
            require(
                setCookie.contains("HttpOnly"),
                "admin session cookie must be HttpOnly"
            );
            require(
                setCookie.contains("SameSite=Strict"),
                "admin session cookie must be SameSite=Strict"
            );
            String sessionCookie = setCookie.split(";", 2)[0];
            String adminSessionId = sessionCookie.substring(
                sessionCookie.indexOf('=') + 1
            );
            java.time.Instant issuedSessionExpiry =
                adminAuthStore.sessionExpiresAt(adminSessionId);

            require(
                adminAuthStore.countActiveSessions(
                    java.time.Instant.now()
                ) == 1,
                "bootstrap authentication must create exactly one session"
            );

            var repeatedBootstrap = client.send(
                HttpRequest.newBuilder(
                    URI.create(server.adminBootstrapUrl())
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.discarding()
            );
            require(
                repeatedBootstrap.statusCode() == 303,
                "existing admin session must redirect from bootstrap URL"
            );
            require(
                repeatedBootstrap.headers()
                    .firstValue("Set-Cookie")
                    .isEmpty(),
                "existing admin session must not receive a replacement session cookie"
            );
            require(
                adminAuthStore.countActiveSessions(
                    java.time.Instant.now()
                ) == 1,
                "reopening bootstrap URL with an existing session must not increase session count"
            );

            var authenticatedAdminPage = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/admin/games/board/")
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                authenticatedAdminPage.statusCode() == 200,
                "authenticated admin page must be served"
            );

            var stateResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/state")
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                stateResponse.statusCode() == 200
                    && stateResponse.body().contains(
                        "\"source\":\"local-admin\""
                    ),
                "authenticated state API must proxy to local admin"
            );
            require(
                issuedSessionExpiry.equals(
                    adminAuthStore.sessionExpiresAt(adminSessionId)
                ),
                "authenticated reads must not rewrite fixed session expiry"
            );

            var authenticatedPost = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/board/rooms")
                )
                .header("Cookie", sessionCookie)
                .header(
                    "Origin",
                    "http://127.0.0.1:" + clientPort
                )
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                authenticatedPost.statusCode() == 200
                    && authenticatedPost.body().contains(
                        "\"proxied\":true"
                    ),
                "authenticated mutation must proxy to local admin"
            );

            var crossOriginBoardPost = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/board/rooms")
                )
                .header("Cookie", sessionCookie)
                .header("Origin", "https://attacker.example")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                crossOriginBoardPost.statusCode() == 403,
                "cross-origin authenticated board mutation must be rejected"
            );

            var viewerDrawCreate = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/v1/tools/viewer-draw/sessions")
                )
                .header("Cookie", sessionCookie)
                .header(
                    "Origin",
                    "http://127.0.0.1:" + clientPort
                )
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    "{\"name\":\"Boundary Number Draw\",\"mode\":\"NUMBER\","
                        + "\"entries\":[],\"config\":{\"maxNumber\":45,\"drawCount\":7}}"
                ))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                viewerDrawCreate.statusCode() == 201,
                "authenticated viewer draw session must be created"
            );

            var crossOriginViewerDraw = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/v1/tools/viewer-draw/sessions")
                )
                .header("Cookie", sessionCookie)
                .header("Origin", "https://attacker.example")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    "{\"mode\":\"NUMBER\","
                        + "\"config\":{\"maxNumber\":45,\"drawCount\":7}}"
                ))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                crossOriginViewerDraw.statusCode() == 403,
                "cross-origin authenticated viewer draw mutation must be rejected"
            );
            var viewerDrawJson = JsonParser.parseString(
                viewerDrawCreate.body()
            ).getAsJsonObject();
            String viewerDrawId = viewerDrawJson
                .get("sessionId")
                .getAsString();
            String viewerDrawCode = viewerDrawJson
                .get("publicCode")
                .getAsString();
            require(
                viewerDrawCode.matches("[A-HJ-NP-Z2-9]{6}"),
                "viewer draw public code must be six characters"
            );

            var viewerDrawFreeze = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/tools/viewer-draw/sessions/"
                            + viewerDrawId + "/freeze"
                    )
                )
                .header("Cookie", sessionCookie)
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                viewerDrawFreeze.statusCode() == 200
                    && viewerDrawFreeze.body().contains(
                        "\"state\":\"FROZEN\""
                    ),
                "viewer draw must freeze before execution"
            );

            var viewerDrawStart = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/tools/viewer-draw/sessions/"
                            + viewerDrawId + "/start"
                    )
                )
                .header("Cookie", sessionCookie)
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                viewerDrawStart.statusCode() == 200
                    && viewerDrawStart.body().contains(
                        "\"state\":\"COMPLETED\""
                    )
                    && viewerDrawStart.body().contains(
                        "\"numbers\""
                    ),
                "number draw must complete through authenticated API"
            );

            var viewerDrawPublic = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/tools/viewer-draw/public/"
                            + viewerDrawCode
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                viewerDrawPublic.statusCode() == 200
                    && viewerDrawPublic.body().contains(
                        "\"publicCode\":\"" + viewerDrawCode + "\""
                    )
                    && viewerDrawPublic.body().contains(
                        "\"result\""
                    ),
                "viewer draw public code must expose read-only result"
            );

            var machineMapSave = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/v1/tools/viewer-draw/maps")
                )
                .header("Cookie", sessionCookie)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    """
                    {
                      "definition":{
                        "schemaVersion":"viewer-draw-machine-map/v0",
                        "name":"Boundary Machine",
                        "world":{
                          "width":1280,
                          "height":720,
                          "gravityX":0,
                          "gravityY":12
                        },
                        "components":[
                          {
                            "id":"spawn-1",
                            "type":"SPAWN",
                            "x":640,
                            "y":70,
                            "rotation":0,
                            "width":0,
                            "height":0,
                            "radius":18,
                            "properties":{"marbleRadius":11}
                          },
                          {
                            "id":"finish-1",
                            "type":"FINISH",
                            "x":640,
                            "y":660,
                            "rotation":0,
                            "width":300,
                            "height":60,
                            "radius":0,
                            "properties":{}
                          }
                        ]
                      }
                    }
                    """
                ))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                machineMapSave.statusCode() == 200
                    && machineMapSave.body().contains(
                        "\"schemaVersion\":\"viewer-draw-machine-map/v0\""
                    )
                    && machineMapSave.body().contains(
                        "\"revision\":1"
                    ),
                "authenticated machine map must save"
            );
            String machineMapId = JsonParser.parseString(
                machineMapSave.body()
            ).getAsJsonObject()
                .get("mapId")
                .getAsString();

            var machineMapRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/tools/viewer-draw/maps/"
                            + machineMapId
                    )
                )
                .header("Cookie", sessionCookie)
                .GET()
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                machineMapRead.statusCode() == 200
                    && machineMapRead.body().contains(
                        "\"mapId\":\"" + machineMapId + "\""
                    )
                    && machineMapRead.body().contains(
                        "\"definitionHash\""
                    ),
                "authenticated machine map must reload"
            );

            var missingArchiveRevision = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/tools/viewer-draw/maps/"
                            + machineMapId
                    )
                )
                .header("Cookie", sessionCookie)
                .header(
                    "Origin",
                    "http://127.0.0.1:" + clientPort
                )
                .DELETE()
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                missingArchiveRevision.statusCode() == 400,
                "machine map archive must require expectedRevision"
            );

            var savedMapJson = JsonParser.parseString(
                machineMapSave.body()
            ).getAsJsonObject();
            var updatePayload =
                new com.google.gson.JsonObject();
            updatePayload.addProperty("mapId", machineMapId);
            updatePayload.addProperty("expectedRevision", 1);
            updatePayload.add(
                "definition",
                savedMapJson.get("definition").deepCopy()
            );

            var machineMapUpdate = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/v1/tools/viewer-draw/maps")
                )
                .header("Cookie", sessionCookie)
                .header(
                    "Origin",
                    "http://127.0.0.1:" + clientPort
                )
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    updatePayload.toString()
                ))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                machineMapUpdate.statusCode() == 200
                    && machineMapUpdate.body().contains(
                        "\"revision\":2"
                    ),
                "machine map update must advance revision"
            );

            var staleArchive = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/tools/viewer-draw/maps/"
                            + machineMapId
                            + "?expectedRevision=1"
                    )
                )
                .header("Cookie", sessionCookie)
                .header(
                    "Origin",
                    "http://127.0.0.1:" + clientPort
                )
                .DELETE()
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                staleArchive.statusCode() == 409,
                "stale machine map archive must return 409"
            );

            var currentArchive = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/tools/viewer-draw/maps/"
                            + machineMapId
                            + "?expectedRevision=2"
                    )
                )
                .header("Cookie", sessionCookie)
                .header(
                    "Origin",
                    "http://127.0.0.1:" + clientPort
                )
                .DELETE()
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                currentArchive.statusCode() == 204,
                "current machine map revision must archive"
            );

            var drawingSessionCreate = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/games/drawing-guess/prototype/session"
                    )
                )
                .header("Cookie", sessionCookie)
                .POST(HttpRequest.BodyPublishers.noBody())
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                drawingSessionCreate.statusCode() == 201,
                "authenticated drawing sync session must be created"
            );
            var drawingSessionJson = JsonParser.parseString(
                drawingSessionCreate.body()
            ).getAsJsonObject();
            String drawingCode = drawingSessionJson
                .get("drawingCode")
                .getAsString();
            require(
                drawingSessionJson.has("drawerToken")
                    && drawingCode.matches("[A-HJ-NP-Z2-9]{6}"),
                "private drawing session must return drawer token and code"
            );

            var drawingPublic = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/games/drawing-guess/prototype/public/"
                            + drawingCode
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                drawingPublic.statusCode() == 200
                    && drawingPublic.body().contains(
                        "\"drawingCode\":\"" + drawingCode + "\""
                    )
                    && !drawingPublic.body().contains("drawerToken"),
                "public drawing session must never expose drawer token"
            );

            var drawingRoomCreate = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/games/drawing-guess/rooms"
                    )
                )
                .header("Cookie", sessionCookie)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    """
                    {
                      "name":"Boundary Drawing Room",
                      "drawerPolicy":"ROTATING_DRAWER",
                      "scoreProfile":"FAST_GUESS",
                      "roundDurationSeconds":60,
                      "participants":[
                        {
                          "participantId":"p1",
                          "provider":"SOOP",
                          "userId":"secret-user-1",
                          "displayName":"P1"
                        },
                        {
                          "participantId":"p2",
                          "provider":"SOOP",
                          "userId":"secret-user-2",
                          "displayName":"P2"
                        }
                      ]
                    }
                    """
                ))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                drawingRoomCreate.statusCode() == 201,
                "drawing guess room must be created by admin"
            );
            var drawingRoomJson = JsonParser.parseString(
                drawingRoomCreate.body()
            ).getAsJsonObject();
            String drawingRoomId = drawingRoomJson
                .get("roomId")
                .getAsString();
            require(
                drawingRoomId.matches("[A-HJ-NP-Z2-9]{6}"),
                "drawing guess room code must be six characters"
            );

            var drawingReady = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/games/drawing-guess/rooms/"
                            + drawingRoomId + "/ready"
                    )
                )
                .header("Cookie", sessionCookie)
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                drawingReady.statusCode() == 200
                    && drawingReady.body().contains(
                        "\"state\":\"READY\""
                    ),
                "drawing guess room must become READY"
            );

            var drawingMatchStart = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/games/drawing-guess/rooms/"
                            + drawingRoomId + "/matches"
                    )
                )
                .header("Cookie", sessionCookie)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    "{\"totalRounds\":2}"
                ))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                drawingMatchStart.statusCode() == 201,
                "drawing guess match must start"
            );
            String drawingMatchId = JsonParser.parseString(
                drawingMatchStart.body()
            ).getAsJsonObject()
                .get("matchId")
                .getAsString();

            var drawingRoundStart = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/games/drawing-guess/matches/"
                            + drawingMatchId + "/rounds"
                    )
                )
                .header("Cookie", sessionCookie)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    """
                    {
                      "promptId":"boundary-prompt",
                      "answer":"사과",
                      "acceptedAnswers":["apple","사 과"]
                    }
                    """
                ))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                drawingRoundStart.statusCode() == 201
                    && drawingRoundStart.body().contains("drawerToken")
                    && drawingRoundStart.body().contains("사과"),
                "private round start must include answer and drawer token"
            );

            var drawingRoundJson = JsonParser.parseString(
                drawingRoundStart.body()
            ).getAsJsonObject();
            String drawingRoundId = drawingRoundJson
                .getAsJsonObject("publicRound")
                .get("roundId")
                .getAsString();

            var drawingPublicRoom = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/games/drawing-guess/public/"
                            + drawingRoomId
                    )
                )
                .GET()
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                drawingPublicRoom.statusCode() == 200
                    && drawingPublicRoom.body().contains(
                        "\"roomId\":\"" + drawingRoomId + "\""
                    )
                    && !drawingPublicRoom.body().contains("사과")
                    && !drawingPublicRoom.body().contains("apple")
                    && !drawingPublicRoom.body().contains("drawerToken")
                    && !drawingPublicRoom.body().contains("secret-user-1")
                    && !drawingPublicRoom.body().contains("secret-user-2"),
                "public drawing room must hide answers, tokens, and provider user IDs"
            );

            var drawingRoundComplete = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/v1/games/drawing-guess/rounds/"
                            + drawingRoundId + "/complete"
                    )
                )
                .header("Cookie", sessionCookie)
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                drawingRoundComplete.statusCode() == 200
                    && drawingRoundComplete.body().contains(
                        "\"state\":\"COMPLETED\""
                    ),
                "drawing guess round must complete"
            );

            String bootstrapBeforeRestart =
                server.adminBootstrapUrl();
            server.close();
            var restartDrawingSync =
                new DrawingSyncService();
            server = new GameClientHttpServer(
                config,
                root,
                rooms,
                runtime,
                new AdminAuthStore(database),
                new PlatformEventBus(),
                new ProviderRegistry(),
                new ViewerDrawService(database),
                restartDrawingSync,
                new DrawingGuessGameService(
                    new DrawingGuessRepository(database),
                    restartDrawingSync
                )
            );
            server.start();

            require(
                !bootstrapBeforeRestart.equals(
                    server.adminBootstrapUrl()
                ),
                "bootstrap token must rotate on every server restart"
            );

            var afterRestartAdminPage = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/admin/games/board/")
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                afterRestartAdminPage.statusCode() == 200,
                "admin session must survive server restart"
            );

            var afterRestartState = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/state")
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                afterRestartState.statusCode() == 200
                    && afterRestartState.body().contains(
                        "\"source\":\"local-admin\""
                    ),
                "persisted admin session must authorize after restart"
            );

            var repeatedBootstrapAfterRestart = client.send(
                HttpRequest.newBuilder(
                    URI.create(server.adminBootstrapUrl())
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.discarding()
            );
            require(
                repeatedBootstrapAfterRestart.statusCode() == 303
                    && repeatedBootstrapAfterRestart.headers()
                        .firstValue("Set-Cookie")
                        .isEmpty(),
                "persisted session must be reused when bootstrap URL is reopened after restart"
            );
            require(
                new AdminAuthStore(database).countActiveSessions(
                    java.time.Instant.now()
                ) == 1,
                "server restart plus existing browser access must not duplicate admin sessions"
            );

            var approvalRequest = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/admin/access/request?returnTo="
                            + java.net.URLEncoder.encode(
                                "/admin/games/board/",
                                StandardCharsets.UTF_8
                            )
                    )
                )
                .POST(HttpRequest.BodyPublishers.noBody())
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                approvalRequest.statusCode() == 201,
                "unauthenticated browser must be able to request admin approval"
            );
            var approvalJson = JsonParser.parseString(
                approvalRequest.body()
            ).getAsJsonObject();
            String requestId = approvalJson
                .get("requestId")
                .getAsString();
            String approvalCode = approvalJson
                .get("approvalCode")
                .getAsString();
            require(
                approvalCode.matches("[A-HJ-NP-Z2-9]{6}"),
                "approval code must be six unambiguous characters"
            );
            require(
                server.pendingAdminApprovalCount() == 1,
                "pending admin approval must be visible to server manager"
            );
            require(
                server.approveAdminAccess(approvalCode),
                "server manager must be able to approve pending code"
            );

            var approvalStatus = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/admin/access/status?requestId="
                            + requestId
                            + "&returnTo="
                            + java.net.URLEncoder.encode(
                                "/admin/games/board/",
                                StandardCharsets.UTF_8
                            )
                    )
                )
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                approvalStatus.statusCode() == 200
                    && approvalStatus.body().contains(
                        "\"status\":\"APPROVED\""
                    )
                    && approvalStatus.body().contains(
                        "\"redirect\":\"/admin/games/board/\""
                    ),
                "approved request must exchange for an admin session"
            );
            String approvalCookie = approvalStatus.headers()
                .firstValue("Set-Cookie")
                .orElseThrow(() -> new IllegalStateException(
                    "approved browser session cookie missing"
                ))
                .split(";", 2)[0];

            var approvedAdminPage = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/admin/games/board/")
                )
                .header("Cookie", approvalCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                approvedAdminPage.statusCode() == 200,
                "approved browser must enter administrator page"
            );
            require(
                server.pendingAdminApprovalCount() == 0,
                "approved request must be one-time and consumed"
            );
            require(
                new AdminAuthStore(database).countActiveSessions(
                    java.time.Instant.now()
                ) == 2,
                "approval of a second browser must add exactly one admin session"
            );

            int lastApprovalStatus = 0;
            for (int attempt = 0; attempt < 4; attempt += 1) {
                var extraApproval = client.send(
                    HttpRequest.newBuilder(
                        base.resolve("/api/admin/access/request")
                    )
                    .POST(HttpRequest.BodyPublishers.noBody())
                    .build(),
                    HttpResponse.BodyHandlers.ofString()
                );
                lastApprovalStatus = extraApproval.statusCode();
                if (attempt < 3) {
                    require(
                        lastApprovalStatus == 201,
                        "approval request rate limit must allow normal burst"
                    );
                }
            }
            require(
                lastApprovalStatus == 429,
                "approval request rate limit must reject excessive requests"
            );

            System.out.println("[client-boundary-probe] PASS");
            return 0;
        } catch (Exception error) {
            System.err.println(
                "[client-boundary-probe] FAIL: "
                    + error.getMessage()
            );
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (server != null) {
                try { server.close(); } catch (Exception ignored) {}
            }
            if (mockAdmin != null) {
                try { mockAdmin.stop(0); } catch (Exception ignored) {}
            }
            if (root != null) {
                try (var paths = Files.walk(root)) {
                    paths.sorted((a, b) -> b.compareTo(a))
                        .forEach(path -> {
                            try {
                                Files.deleteIfExists(path);
                            } catch (Exception ignored) {
                            }
                        });
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static int freePort() throws Exception {
        try (var socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static void require(
        boolean condition,
        String message
    ) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
