package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;

/** Local-only pack management probe; no Piper binary or model download needed. */
public final class TtsVoicePackProbe {
    private TtsVoicePackProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("tts-packs-probe-");
        Path voices = root.resolve("tts/voices");
        Path manifest = root.resolve("tts/voice-packs.json");
        try {
            Files.createDirectories(voices);
            byte[] a = "fixture-model-A".getBytes(StandardCharsets.UTF_8);
            byte[] b = "fixture-model-B".getBytes(StandardCharsets.UTF_8);
            Files.write(voices.resolve("model-a.onnx"), a);
            Files.writeString(voices.resolve("model-a.onnx.json"),
                "{\"language\":{\"code\":\"ko_KR\"}}");
            Files.write(voices.resolve("model-b.onnx"), b);
            Files.writeString(voices.resolve("model-b.onnx.json"),
                "{\"language\":{\"code\":\"en_US\"}}");

            var store = new TtsVoicePackStore(root);
            require(store.mode().equals("LEGACY"), "legacy mode before initial registry");
            require(store.allowed("model-a") && store.allowed("model-b"),
                "existing manually installed voices must remain available");
            require(store.inventory().packs().size() == 2,
                "both safe local file pairs appear in inventory");
            bad(() -> store.register(new TtsVoicePackStore.Registration(
                "model-a", "1.0", "MIT", "0".repeat(64), true)),
                "expected checksum mismatch");
            require(store.mode().equals("LEGACY") && !Files.exists(manifest),
                "a failed registration must not switch mode");
            bad(() -> store.register(new TtsVoicePackStore.Registration(
                "model-a", "1.0", "MIT", digest(a), false)),
                "license acknowledgement");
            require(store.mode().equals("LEGACY"),
                "unacknowledged license must not enable managed mode");

            var inventory = store.register(new TtsVoicePackStore.Registration(
                "model-a", "1.0", "MIT", digest(a), true));
            require(inventory.mode().equals("MANAGED") && Files.exists(manifest),
                "first successful registration enables persistent managed mode");
            require(store.allowed("model-a") && !store.allowed("model-b"),
                "managed allowlist excludes unregistered models");
            require(store.verify("model-a").match(),
                "both model and config hashes match registered fingerprint");
            require(!store.verify("model-b").match(),
                "unregistered candidate must not be treated as verified");
            store.setEnabled("model-a", false);
            require(!store.allowed("model-a"), "disabled voices cannot be used");
            store.setEnabled("model-a", true);
            require(store.allowed("model-a"), "re-enabled matching files work");

            var restored = new TtsVoicePackStore(root);
            require(restored.mode().equals("MANAGED")
                && restored.allowed("model-a") && !restored.allowed("model-b"),
                "manifest and enabled state survive restart");
            Files.writeString(voices.resolve("model-a.onnx.json"),
                "{\"language\":{\"code\":\"en_GB\"}}");
            require(!restored.allowed("model-a"),
                "modified voice config must fail closed at synthesis");
            require(!restored.verify("model-a").match(),
                "changed file must be reported as a checksum mismatch");
            bad(() -> restored.setEnabled("model-a", true),
                "enabling a modified model must be rejected");
            Files.writeString(voices.resolve("model-a.onnx.json"),
                "{\"language\":{\"code\":\"ko_KR\"}}");
            require(restored.allowed("model-a"),
                "restoring original bytes must restore registered usability");

            restored.unregister("model-a");
            require(restored.mode().equals("MANAGED") && !restored.allowed("model-a"),
                "unregister must not fall back to legacy auto-discovery");
            require(Files.exists(voices.resolve("model-a.onnx"))
                && Files.exists(voices.resolve("model-a.onnx.json")),
                "unregister must never delete model or config files");
            require(new TtsVoicePackStore(root).inventory().mode().equals("MANAGED"),
                "empty managed allowlist persists across restart");

            Files.writeString(manifest, "{invalid", StandardCharsets.UTF_8);
            var corrupt = new TtsVoicePackStore(root);
            require(corrupt.mode().equals("INVALID")
                && !corrupt.allowed("model-a"),
                "invalid registry must disable ALL Piper packs");
            bad(() -> corrupt.register(new TtsVoicePackStore.Registration(
                "model-a", "1.0", "MIT", digest(a), true)),
                "corruption requires manual repair rather than overwrite");
            require(Files.readString(manifest).equals("{invalid"),
                "bad registry retained for operator recovery");
            System.out.println("TTS local voice pack allowlist/integrity/persistence probe passed.");
        } finally {
            try (var files = Files.walk(root)) {
                files.sorted((a, b) -> b.compareTo(a)).forEach(file -> {
                    try { Files.deleteIfExists(file); }
                    catch (Exception ignored) {}
                });
            }
        }
    }

    private static String digest(byte[] input) throws Exception {
        return HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(input));
    }
    private interface Checked { void run() throws Exception; }
    private static void bad(Checked action, String why) throws Exception {
        try { action.run(); }
        catch (IllegalArgumentException | IllegalStateException expected) { return; }
        throw new IllegalStateException("expected rejection: " + why);
    }
    private static void require(boolean condition, String description) {
        if (!condition) throw new IllegalStateException(description);
    }
}
