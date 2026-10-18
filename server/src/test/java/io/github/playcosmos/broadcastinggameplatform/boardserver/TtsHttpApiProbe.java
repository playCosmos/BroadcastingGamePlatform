package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.tts.TtsPreferencesStore;
import io.github.playcosmos.broadcastinggameplatform.platform.tts.TtsVoiceProfileStore;
import io.github.playcosmos.broadcastinggameplatform.platform.tts.TtsVoicePackStore;
import java.security.MessageDigest;
import java.util.HexFormat;
import io.github.playcosmos.broadcastinggameplatform.platform.tts.TtsService;
import io.github.playcosmos.broadcastinggameplatform.platform.tts.PiperEngine;
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
            List.of(new FakeEngine(), new PiperEngine(root.resolve("tts/voices"))),
            new TtsPreferencesStore(root.resolve("tts-settings.json")),
            new TtsVoiceProfileStore(root.resolve("tts-profiles.json")),
            new TtsVoicePackStore(root))) {
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
                    "/api/v1/tts/profiles", "/api/v1/tts/packs",
                    "/api/v1/tts/piper/runtime",
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

            var runtimeBefore = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/piper/runtime"))
                .header("Cookie", cookie).GET().build(),
                HttpResponse.BodyHandlers.ofString());
            require(runtimeBefore.statusCode() == 200
                && runtimeBefore.body().contains("\"idleSeconds\":60")
                && !runtimeBefore.body().contains("python.exe")
                && !runtimeBefore.body().contains("\"pid\""),
                "runtime status must not disclose paths, process IDs or private input");
            String policy = "{\"enabled\":false,\"idleSeconds\":120}";
            var originlessRuntime = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/piper/runtime"))
                .header("Cookie", cookie)
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(policy)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(originlessRuntime.statusCode() == 403,
                "originless Piper runtime mutations must be rejected");
            var foreignRuntime = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/piper/runtime"))
                .header("Cookie", cookie)
                .header("Origin", "https://attacker.example")
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(policy)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(foreignRuntime.statusCode() == 403,
                "cross-origin Piper settings must be rejected");
            var badRuntime = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/piper/runtime"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(
                    "{\"enabled\":false,\"idleSeconds\":4.5}")).build(),
                HttpResponse.BodyHandlers.ofString());
            require(badRuntime.statusCode() == 400,
                "runtime idle timeout must be a bounded integer");
            var unavailableRuntime = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/piper/runtime"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(
                    "{\"enabled\":true,\"idleSeconds\":60}")).build(),
                HttpResponse.BodyHandlers.ofString());
            require(unavailableRuntime.statusCode() == 400,
                "runtime cannot be enabled without operator-provided interpreter");
            var savedRuntime = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/piper/runtime"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(policy)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(savedRuntime.statusCode() == 200
                && savedRuntime.body().contains("\"idleSeconds\":120")
                && Files.exists(root.resolve("tts/piper-runtime.json")),
                "Piper runtime settings must persist via admin API");
            var releasedRuntime = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/piper/runtime/release"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .POST(HttpRequest.BodyPublishers.noBody()).build(),
                HttpResponse.BodyHandlers.ofString());
            require(releasedRuntime.statusCode() == 200,
                "admin release must not require raw native process identifiers");
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

            var noOriginDefaults = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/settings"))
                .header("Cookie", cookie)
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(
                    "{\"voiceId\":\"http-tts/Voice\",\"rate\":0,\"volume\":80}"))
                .build(), HttpResponse.BodyHandlers.ofString());
            require(noOriginDefaults.statusCode() == 403,
                "originless TTS defaults mutation must be blocked");
            var noOriginCancel = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/queue"))
                .header("Cookie", cookie)
                .DELETE().build(), HttpResponse.BodyHandlers.ofString());
            require(noOriginCancel.statusCode() == 403,
                "originless TTS queue deletion must be blocked");
            var saved = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/settings"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(
                    "{\"voiceId\":\"http-tts/Voice\",\"rate\":1,\"volume\":70}"))
                .build(), HttpResponse.BodyHandlers.ofString());
            require(saved.statusCode() == 200
                && saved.body().contains("http-tts/Voice"),
                "trusted TTS defaults mutation should persist");
            String profileJson = """
                {"name":"Korean default","voiceId":"http-tts/Voice","rate":-2,"volume":75}
                """;
            var unauthorizedProfileWrite = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/profiles"))
                .header("Cookie", cookie)
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(profileJson)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(unauthorizedProfileWrite.statusCode() == 403,
                "originless TTS profile mutations must be rejected");
            var crossOriginProfileWrite = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/profiles"))
                .header("Cookie", cookie)
                .header("Origin", "https://attacker.example")
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(profileJson)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(crossOriginProfileWrite.statusCode() == 403,
                "cross-origin TTS profile mutations must be rejected");
            var profileSave = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/profiles"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(profileJson)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(profileSave.statusCode() == 200
                && profileSave.body().contains("Korean default")
                && Files.exists(root.resolve("tts-profiles.json")),
                "trusted profile writes must persist independently of defaults");
            var profileList = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/profiles"))
                .header("Cookie", cookie)
                .GET().build(), HttpResponse.BodyHandlers.ofString());
            require(profileList.statusCode() == 200
                && profileList.body().contains("http-tts/Voice"),
                "authenticated profile reads should expose persisted voice ID");
            var invalidProfile = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/profiles"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(
                    "{\"name\":\" \",\"voiceId\":\"http-tts/Voice\",\"rate\":0,\"volume\":80}")).build(),
                HttpResponse.BodyHandlers.ofString());
            require(invalidProfile.statusCode() == 400,
                "invalid profile names must be rejected");
            var noOriginDelete = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/profiles"))
                .header("Cookie", cookie)
                .header("Content-Type", "application/json")
                .method("DELETE", HttpRequest.BodyPublishers.ofString(
                    "{\"name\":\"Korean default\"}")).build(),
                HttpResponse.BodyHandlers.ofString());
            require(noOriginDelete.statusCode() == 403,
                "originless profile deletion must be rejected");
            var profileDelete = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/profiles"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .method("DELETE", HttpRequest.BodyPublishers.ofString(
                    "{\"name\":\"Korean default\"}")).build(),
                HttpResponse.BodyHandlers.ofString());
            require(profileDelete.statusCode() == 200
                && !profileDelete.body().contains("Korean default"),
                "profile deletion must remove the selected name");
            // The pack API never accepts uploads, arbitrary paths or deletion
            // of the physical ONNX/JSON pair.
            Path voicesRoot = root.resolve("tts/voices");
            Files.createDirectories(voicesRoot);
            byte[] fakeModel = "sample-onnx".getBytes(StandardCharsets.UTF_8);
            Files.write(voicesRoot.resolve("voice-test.onnx"), fakeModel);
            Files.writeString(voicesRoot.resolve("voice-test.onnx.json"),
                "{\"language\":{\"code\":\"ko_KR\"}}");
            String expectedHash = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(fakeModel));
            String registration = "{\"model\":\"voice-test\","
                + "\"version\":\"1.0\",\"license\":\"MIT\","
                + "\"sha256\":\"" + expectedHash + "\","
                + "\"licenseAcknowledged\":true}";
            var unauthPack = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/packs"))
                .header("Cookie", cookie)
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(registration)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(unauthPack.statusCode() == 403,
                "pack registry requires a same-origin mutation");
            var badChecksum = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/packs"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(
                    registration.replace(expectedHash, "0".repeat(64)))).build(),
                HttpResponse.BodyHandlers.ofString());
            require(badChecksum.statusCode() == 400,
                "expected SHA must match before enabling managed mode");
            var registered = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/packs"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(registration)).build(),
                HttpResponse.BodyHandlers.ofString());
            require(registered.statusCode() == 200
                && registered.body().contains("MANAGED"),
                "trusted registration should create managed voice allowlist");
            var checked = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/packs/verify"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    "{\"model\":\"voice-test\"}")).build(),
                HttpResponse.BodyHandlers.ofString());
            require(checked.statusCode() == 200
                && checked.body().contains("\"match\":true"),
                "pack verification must match trusted model and JSON digests");
            var disabled = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/packs/status"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                    "{\"model\":\"voice-test\",\"enabled\":false}")).build(),
                HttpResponse.BodyHandlers.ofString());
            require(disabled.statusCode() == 200
                && disabled.body().contains("DISABLED"),
                "pack disabling must update the managed inventory");
            var deleted = client.send(HttpRequest.newBuilder(
                base.resolve("/api/v1/tts/packs"))
                .header("Cookie", cookie)
                .header("Origin", base.toString())
                .header("Content-Type", "application/json")
                .method("DELETE", HttpRequest.BodyPublishers.ofString(
                    "{\"model\":\"voice-test\"}")).build(),
                HttpResponse.BodyHandlers.ofString());
            require(deleted.statusCode() == 200
                && Files.exists(voicesRoot.resolve("voice-test.onnx")),
                "unregister must never physically remove model files");
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
