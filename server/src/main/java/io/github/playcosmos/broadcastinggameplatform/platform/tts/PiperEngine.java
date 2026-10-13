package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

/**
 * Optional local Piper neural TTS voice adapter. The executable must have
 * been installed independently on PATH; models are read only from the
 * application-owned tts/voices directory. Nothing is downloaded/executed
 * from that directory, and model files are never served to HTTP clients.
 */
public final class PiperEngine implements TtsService.TtsEngine {
    private static final int MAX_MODELS = 64;
    private static final int MAX_CONFIG_BYTES = 256 * 1024;
    private static final int MAX_WAV_BYTES = 5 * 1024 * 1024;
    private final Path voicesDirectory;
    private volatile Map<String, ModelVoice> catalog = Map.of();
    private volatile long cachedAt;

    record ModelVoice(TtsService.Voice voice, Path model, Path config,
        Integer speaker) {}

    public PiperEngine(Path voicesDirectory) {
        this.voicesDirectory = voicesDirectory.toAbsolutePath().normalize();
    }

    @Override public String id() { return "piper"; }

    @Override public synchronized void invalidateVoiceCatalog() {
        cachedAt = 0;
    }

    @Override
    public synchronized List<TtsService.Voice> voices() throws Exception {
        long now = System.nanoTime();
        if (cachedAt != 0
            && now - cachedAt < Duration.ofMinutes(2).toNanos()) {
            return catalog.values().stream().map(ModelVoice::voice).toList();
        }
        if (!Files.isDirectory(voicesDirectory)
            || Files.isSymbolicLink(voicesDirectory)
            || !executableAvailable()) {
            catalog = Map.of();
            cachedAt = now;
            return List.of();
        }
        var discovered = new LinkedHashMap<String, ModelVoice>();
        try (Stream<Path> files = Files.list(voicesDirectory)) {
            var models = files.filter(file ->
                !Files.isSymbolicLink(file)
                && Files.isRegularFile(file)
                && file.getFileName().toString().endsWith(".onnx")
            ).sorted(Comparator.comparing(Path::toString))
                .limit(MAX_MODELS + 1).toList();
            if (models.size() > MAX_MODELS) {
                throw new IllegalStateException("Piper voice limit exceeded");
            }
            for (Path model : models) {
                String filename = model.getFileName().toString();
                String stem = filename.substring(0, filename.length() - 5);
                if (!stem.matches("[A-Za-z0-9][A-Za-z0-9_.+-]{0,95}")) continue;
                Path config = voicesDirectory.resolve(filename + ".json");
                if (Files.isSymbolicLink(config)
                    || !Files.isRegularFile(config)
                    || Files.size(config) > MAX_CONFIG_BYTES) continue;
                try {
                    for (ModelVoice candidate : parseModelConfig(
                        stem, model, config,
                        Files.readString(config, StandardCharsets.UTF_8))) {
                        discovered.putIfAbsent(candidate.voice().id(), candidate);
                    }
                } catch (RuntimeException invalidConfig) {
                    System.err.println("[tts] invalid Piper voice config: " + stem);
                }
            }
        }
        catalog = Map.copyOf(discovered);
        cachedAt = now;
        return discovered.values().stream().map(ModelVoice::voice).toList();
    }

    static List<ModelVoice> parseModelConfig(String stem, Path model,
        Path config, String source) {
        JsonObject root = JsonParser.parseString(source).getAsJsonObject();
        JsonObject language = root.getAsJsonObject("language");
        String locale = "und";
        if (language != null && language.has("code")) {
            locale = language.get("code").getAsString().replace('_', '-');
        }
        if (!locale.matches("[a-zA-Z0-9-]{2,24}")) locale = "und";
        String gender = "unknown";
        // Model config does not reliably encode voice gender.
        var result = new ArrayList<ModelVoice>();
        JsonObject speakers = root.getAsJsonObject("speaker_id_map");
        if (speakers != null && speakers.size() > 0) {
            var names = new ArrayList<>(speakers.entrySet());
            names.sort(Comparator.comparingInt(entry -> speakerId(entry.getValue())));
            for (var entry : names) {
                int number = speakerId(entry.getValue());
                if (number < 0 || number > 255 || result.size() >= 128) continue;
                String name = entry.getKey();
                if (name.isBlank() || name.length() > 80) continue;
                String key = "piper/" + stem + "~" + number;
                var voice = new TtsService.Voice(
                    key, "piper", stem + " · " + name, locale,
                    gender, List.of("neural"), "local-model");
                result.add(new ModelVoice(voice, model, config, number));
            }
        } else {
            var voice = new TtsService.Voice(
                "piper/" + stem, "piper", stem, locale,
                gender, List.of("neural"), "local-model");
            result.add(new ModelVoice(voice, model, config, null));
        }
        return List.copyOf(result);
    }

    private static int speakerId(JsonElement value) {
        try { return value.getAsInt(); }
        catch (RuntimeException error) { return -1; }
    }

    @Override
    public byte[] synthesize(String voiceId, String text, int rate, int volume)
        throws Exception {
        ModelVoice selected = catalog.get(voiceId);
        if (selected == null || voices().stream().noneMatch(
            v -> v.id().equals(voiceId))) {
            throw new IllegalArgumentException("Piper voice unavailable");
        }
        // Re-check the trust boundary after discovery, before execution.
        if (!selected.model().getParent().equals(voicesDirectory)
            || !selected.config().getParent().equals(voicesDirectory)
            || Files.isSymbolicLink(selected.model())
            || Files.isSymbolicLink(selected.config())
            || !Files.isRegularFile(selected.model())
            || !Files.isRegularFile(selected.config())) {
            throw new IllegalStateException("Piper model unavailable");
        }
        Path wav = Files.createTempFile("bgp-piper-output-", ".wav");
        try {
            // Piper length_scale: >1 slower, <1 faster.
            double lengthScale = Math.max(.65, Math.min(1.8,
                1.0 - rate * .045));
            var command = new ArrayList<>(List.of(
                "piper", "--model", selected.model().toString(),
                "--config", selected.config().toString(),
                "--output_file", wav.toString(),
                "--length_scale", String.format(java.util.Locale.ROOT,
                    "%.3f", lengthScale)));
            if (selected.speaker() != null) {
                command.add("--speaker");
                command.add(selected.speaker().toString());
            }
            Process process = new ProcessBuilder(command)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start();
            try {
                try (var input = process.getOutputStream()) {
                    input.write((text + "\n").getBytes(StandardCharsets.UTF_8));
                }
                if (!process.waitFor(30, TimeUnit.SECONDS)) {
                    TtsProcessCleanup.terminate(process);
                    throw new IllegalStateException("Piper synthesis timeout");
                }
                if (process.exitValue() != 0
                    || Files.size(wav) < 44
                    || Files.size(wav) > MAX_WAV_BYTES) {
                    throw new IllegalStateException("Piper synthesis failed");
                }
                byte[] data = Files.readAllBytes(wav);
                return scalePcm16Wav(data, volume);
            } finally {
                TtsProcessCleanup.terminate(process);
            }
        } finally {
            Files.deleteIfExists(wav);
        }
    }

    /** Adjust only uncompressed 16-bit PCM WAV, reject unsupported audio. */
    static byte[] scalePcm16Wav(byte[] input, int volume) {
        if (volume < 0 || volume > 100 || input == null || input.length < 44
            || !chunk(input, 0, "RIFF") || !chunk(input, 8, "WAVE")) {
            throw new IllegalArgumentException("invalid WAV data");
        }
        int position = 12;
        boolean pcm16 = false;
        int dataStart = -1;
        int dataLength = 0;
        while (position + 8 <= input.length) {
            long length = unsigned32(input, position + 4);
            if (length > input.length - position - 8) {
                throw new IllegalArgumentException("WAV chunk overflow");
            }
            if (chunk(input, position, "fmt ")) {
                pcm16 = length >= 16
                    && unsigned16(input, position + 8) == 1
                    && unsigned16(input, position + 22) == 16;
            }
            if (chunk(input, position, "data")) {
                dataStart = position + 8;
                dataLength = (int) length;
            }
            position += 8 + (int) length + ((length & 1) == 1 ? 1 : 0);
        }
        if (!pcm16 || dataStart < 0 || dataLength % 2 != 0) {
            throw new IllegalArgumentException("unsupported WAV encoding");
        }
        if (volume == 100) return input;
        byte[] output = input.clone();
        for (int at = dataStart; at < dataStart + dataLength; at += 2) {
            short sample = (short) unsigned16(input, at);
            int adjusted = (int) Math.round(sample * volume / 100.0);
            output[at] = (byte) adjusted;
            output[at + 1] = (byte) (adjusted >>> 8);
        }
        return output;
    }

    private static boolean chunk(byte[] data, int index, String signature) {
        return data.length >= index + 4
            && data[index] == signature.charAt(0)
            && data[index + 1] == signature.charAt(1)
            && data[index + 2] == signature.charAt(2)
            && data[index + 3] == signature.charAt(3);
    }

    private static int unsigned16(byte[] data, int index) {
        return (data[index] & 255) | ((data[index + 1] & 255) << 8);
    }

    private static long unsigned32(byte[] data, int index) {
        return (unsigned16(data, index) & 0xffffL)
            | ((unsigned16(data, index + 2) & 0xffffL) << 16);
    }

    private static boolean executableAvailable() {
        Process process;
        try {
            process = new ProcessBuilder("piper", "--help")
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start();
        } catch (IOException notInstalled) {
            return false;
        }
        try {
            if (!process.waitFor(3, TimeUnit.SECONDS)) {
                TtsProcessCleanup.terminate(process);
                return false;
            }
            return process.exitValue() == 0;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        } finally {
            if (process.isAlive()) process.destroyForcibly();
        }
    }
}
