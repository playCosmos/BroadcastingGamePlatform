package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.tts.TtsPreferencesStore;
import io.github.playcosmos.broadcastinggameplatform.platform.tts.TtsService;
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
import java.util.concurrent.TimeUnit;

/** End-to-end administrator-only TTS HTTP access and preview regression. */
public final class TtsHttpApiProbe {
    private TtsHttpApiProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("tts-http-api-probe-");
        GameClientHttpServer server = null;
        try (var tts = new TtsService(
            List.of(new FakeEngine()),
            new TtsPreferencesStore(root.resolve("tts-settings.json")))) {
            Path web = root.resolve("web");
            Files.createDirectories(web.resolve("admin"));
            Files.writeString(web.resolve("index.html"), "Platform probe");
            Files.writeString(web.resolve("admin/index.html"), "Admin probe");
            int clientPort = freePort();
            int adminPort = freePort();
            int wsPort = freePort();
            var config = new BoardServerConfig("",
                new BoardServerConfig.Server("127.0.0.1", adminPort, wsPort,
                    false, "127.0.0.1", clientPort, "", ""),
                new BoardServerConfig.Storage("./data/tts-http-probe.db",
                    "./web", "./logs"),
                new BoardServerConfig.Soop(false, 30)).normalized();
            var db = new BoardGameDatabase(root.resolve("data/tts-http-probe.db"));
            db.initialize();
            var room = new RoomService(db, players -> players);
            var runtime = new BoardGameRuntimeEngine(db, event -> {});
            var drawingSync = new DrawingSyncService();
            var drawings = new DrawingGuessGameService(
                new DrawingGuessRepository(db), drawingSync);
            server = new GameClientHttpServer(
                config, root, room, runtime, new AdminAuthStore(db),
                new PlatformEventBus(), new ProviderRegistry(),
                new ViewerDrawService(db), drawingSync, drawings, tts);
            server.start();
            URI base = URI.create("http://127.0.0.1:" + clientPort);
            var client = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER).build();

            for (String path : List.of("/api/v1/tts/voices",
                    "/api/v1/tts/status", "/api/v1/tts/settings",
                    "/api/v1/tts/jobs/00000000-0000-0000-0000-000000000000/audio")) {
                var response = client.send(HttpRequest.newBuilder(
                    base.resolve(path)).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
                require(response.statusCode() == 401,
                    "unauthenticated TTS reads must be rejected: " + path);
            }
            String payload = """
                {"text":"private admin speech","voiceId":"http-tts/Voice","rate":0,"volume":80}
                """;
            var unauthPost = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/speak"))
                .header("Content-Type", "application/json")
                .header("Origin", base.toString())
                .POST(HttpRequest.BodyPublishers.ofString(payload)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(unauthPost.statusCode() == 401,
                "unauthenticated synthesis must be rejected");

            var bootstrap = client.send(HttpRequest.newBuilder(
                URI.create(server.adminBootstrapUrl())).GET().build(),
                HttpResponse.BodyHandlers.discarding());
            require(bootstrap.statusCode() == 303,
                "local bootstrap should create an administrator session");
            String cookie = bootstrap.headers().firstValue("Set-Cookie")
                .orElseThrow().split(";", 2)[0];

            var voices = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/voices")).header("Cookie", cookie)
                .GET().build(), HttpResponse.BodyHandlers.ofString());
            require(voices.statusCode() == 200
                && voices.body().contains("http-tts/Voice"),
                "authenticated voice catalog must include installed engines");
            var status = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/status")).header("Cookie", cookie)
                .GET().build(), HttpResponse.BodyHandlers.ofString());
            require(status.statusCode() == 200
                && status.body().contains("maxRetainedAudioBytes"),
                "administrator status must expose bounded preview cache budget");

            for (String rejectedOrigin : List.of("https://attacker.example")) {
                var forbidden = client.send(HttpRequest.newBuilder(
                    base.resolve("/api/v1/tts/speak"))
                    .header("Cookie", cookie)
                    .header("Origin", rejectedOrigin)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(payload)).build(),
                    HttpResponse.BodyHandlers.ofString());
                require(forbidden.statusCode() == 403,
                    "cross-origin synthesis must be blocked");
            }
            var noOrigin = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/speak"))
                .header("Cookie", cookie)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(noOrigin.statusCode() == 403,
                "originless synthesis must not pass browser CSRF policy");

            var accepted = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/speak"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(accepted.statusCode() == 202,
                "authenticated same-origin preview must enqueue");
            String id = JsonParser.parseString(accepted.body())
                .getAsJsonObject().get("id").getAsString();
            URI jobUri = base.resolve("/api/v1/tts/jobs/" + id);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            boolean ready = false;
            while (System.nanoTime() < deadline) {
                var response = client.send(HttpRequest.newBuilder(jobUri)
                    .header("Cookie", cookie).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
                require(response.statusCode() == 200
                    && !response.body().contains("private admin speech"),
                    "job metadata must remain private and sanitized");
                String state = JsonParser.parseString(response.body())
                    .getAsJsonObject().get("status").getAsString();
                if ("READY".equals(state)) { ready = true; break; }
                if ("FAILED".equals(state)) throw new IllegalStateException(
                    "mock synthesis unexpectedly failed");
                Thread.sleep(20);
            }
            require(ready, "valid admin speech should synthesize");

            var audio = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/jobs/" + id + "/audio"))
                .header("Cookie", cookie).GET().build(),
                HttpResponse.BodyHandlers.ofByteArray());
            require(audio.statusCode() == 200 && audio.body().length == 46,
                "ready audio must be returned only to the session");
            require("audio/wav".equals(audio.headers().firstValue(
                "Content-Type").orElse("")),
                "administrator audio response must use WAV content type");
            require("no-store".equals(audio.headers().firstValue(
                "Cache-Control").orElse("")),
                "generated speech must not be cached by intermediaries");

            var cancel = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/queue"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .DELETE().build(), HttpResponse.BodyHandlers.ofString());
            require(cancel.statusCode() == 200
                && cancel.body().contains("cancelled"),
                "administrators must be able to cancel waiting speech");

            System.out.println("TTS HTTP admin authentication/preview probe passed.");
        } finally {
            if (server != null) try { server.close(); }
                catch (Exception ignored) {}
            try (var files = Files.walk(root)) {
                files.sorted((a, b) -> b.compareTo(a)).forEach(file -> {
                    try { Files.deleteIfExists(file); }
                    catch (Exception ignored) {}
                });
            }
        }
    }

    private static int freePort() throws Exception {
        try (var socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static void require(boolean actual, String message) {
        if (!actual) throw new IllegalStateException(message);
    }

    private static final class FakeEngine implements TtsService.TtsEngine {
        @Override public String id() { return "http-tts"; }
        @Override public List<TtsService.Voice> voices() {
            return List.of(new TtsService.Voice(
                "http-tts/Voice", "http-tts", "Voice", "ko-KR"));
        }
        @Override public byte[] synthesize(
            String voiceId, String text, int rate, int volume) {
            byte[] wav = new byte[46];
            put(wav, 0, "RIFF");
            write32(wav, 4, 38);
            put(wav, 8, "WAVE");
            put(wav, 12, "fmt ");
            write32(wav, 16, 16);
            wav[20] = 1;
            wav[22] = 1;
            write32(wav, 24, 22050);
            write32(wav, 28, 44100);
            wav[32] = 2;
            wav[34] = 16;
            put(wav, 36, "data");
            write32(wav, 40, 2);
            return wav;
        }
        private static void put(byte[] bytes, int at, String value) {
            for (int i = 0; i < value.length(); i++)
                bytes[at + i] = (byte) value.charAt(i);
        }
        private static void write32(byte[] bytes, int at, int value) {
            for (int i = 0; i < 4; i++)
                bytes[at + i] = (byte) (value >>> (i * 8));
        }
    }
}
