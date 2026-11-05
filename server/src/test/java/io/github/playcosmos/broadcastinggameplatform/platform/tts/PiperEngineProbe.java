package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.LinkedHashMap;

/** No Piper executable or voice models are required for this contract test. */
public final class PiperEngineProbe {
    private PiperEngineProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("tts-piper-probe-");
        try {
            var registry = TtsEngineRegistry.installed(root);
            require(registry.stream().anyMatch(e -> "piper".equals(e.id())),
                "application-owned Piper engine should register");
            var engine = new PiperEngine(root.resolve("tts/voices"));
            require(engine.voices().isEmpty(), "absent voice packs are optional");

            Path model = root.resolve("tts/voices/en_US-amy.onnx");
            Path config = root.resolve("tts/voices/en_US-amy.onnx.json");
            String single = """
                {"language":{"code":"en_US"},"num_speakers":1}
                """;
            var simple = PiperEngine.parseModelConfig(
                "en_US-amy", model, config, single);
            require(simple.size() == 1, "single speaker model");
            require("piper/en_US-amy".equals(simple.getFirst().voice().id()),
                "stable voice id from model stem");
            require("en-US".equals(simple.getFirst().voice().language()),
                "language metadata normalized");
            require(simple.getFirst().speaker() == null,
                "single speaker uses default Piper speaker");

            String multi = """
                {"language":{"code":"ko_KR"},"speaker_id_map":{
                    "Speaker Two":2,"Speaker One":0}}
                """;
            var multiple = PiperEngine.parseModelConfig(
                "ko_KR-voices", model, config, multi);
            require(multiple.size() == 2, "multi-speaker voice catalog");
            require("piper/ko_KR-voices~0".equals(multiple.getFirst().voice().id()),
                "speaker id sorting and distinct voice variants");
            require(multiple.getFirst().voice().name().contains("Speaker One"),
                "speaker names must be displayed");
            require("ko-KR".equals(multiple.getFirst().voice().language()),
                "Korean language tag must be retained");
            require(multiple.get(1).speaker() == 2,
                "subsequent speaker ids selected correctly");

            String duplicates = """
                {"language":{"code":"ko_KR"},"speaker_id_map":{
                    "Zulu":2,"Beta":0,"Alpha":0,"Gamma":1}}
                """;
            var unique = PiperEngine.parseModelConfig(
                "ko_KR-duplicate", model, config, duplicates);
            require(unique.size() == 3,
                "duplicate speaker numbers must expose one selectable voice");
            require(unique.getFirst().speaker() == 0
                && unique.getFirst().voice().name().contains("Alpha"),
                "equal speaker ids must select a deterministic label");
            require(unique.get(1).speaker() == 1 && unique.get(2).speaker() == 2,
                "speaker catalog must retain numeric order");
            var ordered = new LinkedHashMap<String, PiperEngine.ModelVoice>();
            ordered.put(unique.get(2).voice().id(), unique.get(2));
            ordered.put(unique.get(0).voice().id(), unique.get(0));
            ordered.put(unique.get(1).voice().id(), unique.get(1));
            var cached = PiperEngine.immutableOrdered(ordered);
            require(cached.keySet().equals(ordered.keySet())
                && List.copyOf(cached.keySet()).equals(List.copyOf(ordered.keySet())),
                "cached catalog must preserve discovery order");
            boolean immutable = false;
            try { cached.clear(); }
            catch (UnsupportedOperationException expected) { immutable = true; }
            require(immutable, "cached Piper catalog must be immutable");

            byte[] sample = pcmWav();
            byte[] muted = PiperEngine.scalePcm16Wav(sample, 0);
            require(read16(muted, 44) == 0 && read16(muted, 46) == 0,
                "volume zero should mute every sample");
            byte[] half = PiperEngine.scalePcm16Wav(sample, 50);
            require(read16(half, 44) == 5000
                && read16(half, 46) == -5000,
                "volume should scale both positive and negative PCM");
            byte[] full = PiperEngine.scalePcm16Wav(sample, 100);
            require(read16(full, 44) == 10000, "100% gain unchanged");
            require(read16(sample, 44) == 10000,
                "gain must not corrupt the source buffer");
            expectInvalid(() -> PiperEngine.scalePcm16Wav(new byte[44], 50),
                "non-RIFF bytes");
            expectInvalid(() -> PiperEngine.scalePcm16Wav(sample, 101),
                "volume above range");
            byte[] truncated = sample.clone();
            write32(truncated, 40, 50);
            expectInvalid(() -> PiperEngine.scalePcm16Wav(truncated, 50),
                "truncated WAV chunk");

            // Stdio framing must reject truncation even when a short frame
            // still has a superficially valid WAV header length (>=44).
            var framed = new java.io.ByteArrayOutputStream();
            try (var data = new java.io.DataOutputStream(framed)) {
                data.writeInt(sample.length);
                data.write(sample);
            }
            require(java.util.Arrays.equals(PiperWarmWorker.readWavFrame(
                new java.io.ByteArrayInputStream(framed.toByteArray())), sample),
                "complete length-prefixed WAV must round trip");
            var truncatedFrame = new java.io.ByteArrayOutputStream();
            try (var data = new java.io.DataOutputStream(truncatedFrame)) {
                data.writeInt(sample.length + 1);
                data.write(sample);
            }
            boolean truncatedRejected = false;
            try {
                PiperWarmWorker.readWavFrame(new java.io.ByteArrayInputStream(
                    truncatedFrame.toByteArray()));
            } catch (java.io.IOException expected) { truncatedRejected = true; }
            require(truncatedRejected, "short WAV frame must not be accepted");
            for (int invalidLength : List.of(43, 5 * 1024 * 1024 + 1, -1)) {
                var bogus = new java.io.ByteArrayOutputStream();
                try (var data = new java.io.DataOutputStream(bogus)) {
                    data.writeInt(invalidLength);
                }
                boolean rejected = false;
                try {
                    PiperWarmWorker.readWavFrame(new java.io.ByteArrayInputStream(
                        bogus.toByteArray()));
                } catch (java.io.IOException expected) { rejected = true; }
                require(rejected, "invalid WAV frame length must fail closed");
            }

            System.out.println("Piper local voice manifest/PCM/regression probe passed.");
        } finally {
            Files.deleteIfExists(root);
        }
    }

    private static byte[] pcmWav() {
        byte[] bytes = new byte[48];
        writeAscii(bytes, 0, "RIFF");
        write32(bytes, 4, 40);
        writeAscii(bytes, 8, "WAVE");
        writeAscii(bytes, 12, "fmt ");
        write32(bytes, 16, 16);
        write16(bytes, 20, 1);
        write16(bytes, 22, 1);
        write32(bytes, 24, 22050);
        write32(bytes, 28, 44100);
        write16(bytes, 32, 2);
        write16(bytes, 34, 16);
        writeAscii(bytes, 36, "data");
        write32(bytes, 40, 4);
        write16(bytes, 44, 10000);
        write16(bytes, 46, -10000);
        return bytes;
    }

    private static int read16(byte[] b, int at) {
        return (short)((b[at] & 255) | (b[at + 1] << 8));
    }
    private static void writeAscii(byte[] b, int at, String text) {
        for (int i = 0; i < text.length(); i++) b[at + i] = (byte)text.charAt(i);
    }
    private static void write16(byte[] b, int at, int value) {
        b[at] = (byte)value;
        b[at + 1] = (byte)(value >>> 8);
    }
    private static void write32(byte[] b, int at, int value) {
        write16(b, at, value);
        write16(b, at + 2, value >>> 16);
    }
    private interface Checked { void run(); }
    private static void expectInvalid(Checked action, String reason) {
        try { action.run(); }
        catch (IllegalArgumentException expected) { return; }
        throw new IllegalStateException("expected rejection: " + reason);
    }
    private static void require(boolean ok, String message) {
        if (!ok) throw new IllegalStateException(message);
    }
}
