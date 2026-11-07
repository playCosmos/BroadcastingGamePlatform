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
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

/**
 * Optional local Piper neural TTS voice adapter. The executable must have
 * been installed independently on PATH; models are read only from the
 * application-owned tts/voices directory. Nothing is downloaded/executed
 * from that directory, and model files are never served to HTTP clients.
 */
public final class PiperEngine implements TtsService.TtsEngine, AutoCloseable {
    private static final int MAX_MODELS = 64;
    private static final int MAX_CONFIG_BYTES = 256 * 1024;
    private static final int MAX_WAV_BYTES = 5 * 1024 * 1024;
    private final Path voicesDirectory;
    private final TtsVoicePackStore packStore;
    private final Path warmPython;
    private final PiperRuntimeSettingsStore runtimeSettings;
    private volatile PiperWarmWorker warmWorker;
    private final AtomicLong fallbackCount = new AtomicLong();
    private final Runnable beforeColdLaunch;
    private final Object coldLifecycle = new Object();
    private final Set<Process> activeColdProcesses = new HashSet<>();
    private volatile boolean closed;
    private volatile Map<String, ModelVoice> catalog = Map.of();
    private volatile long cachedAt;

    public record RuntimeInfo(
        boolean available, boolean enabled, boolean invalidSettings,
        int idleSeconds, String state, String model, Long rssKiB,
        long launched, long completed, long failed, long timedOut,
        long fallbacks, long lastStartupMs, long lastSynthMs, long averageSynthMs
    ) {}

    record ModelVoice(TtsService.Voice voice, Path model, Path config,
        Integer speaker) {}

    public PiperEngine(Path voicesDirectory) {
        this(voicesDirectory, null);
    }

    public PiperEngine(Path voicesDirectory, TtsVoicePackStore packStore) {
        this(voicesDirectory, packStore, PiperWarmWorker.configuredPython());
    }

    // Explicit dependency seam for opt-in real engine integration probes.
    PiperEngine(Path voicesDirectory, TtsVoicePackStore packStore, Path warmPython) {
        this(voicesDirectory, packStore, warmPython, () -> {});
    }

    // Regression seam: pause after warm failure but before cold process startup.
    PiperEngine(Path voicesDirectory, TtsVoicePackStore packStore, Path warmPython,
                Runnable beforeColdLaunch) {
        this.voicesDirectory = voicesDirectory.toAbsolutePath().normalize();
        this.packStore = packStore;
        this.beforeColdLaunch = Objects.requireNonNull(beforeColdLaunch);
        this.warmPython = warmPython;
        Path parent = this.voicesDirectory.getParent();
        Path root = parent != null && "tts".equals(parent.getFileName().toString())
            ? parent.getParent() : parent;
        this.runtimeSettings = new PiperRuntimeSettingsStore(
            Objects.requireNonNull(root, "application root"), warmPython != null);
        var policy = runtimeSettings.get();
        this.warmWorker = warmPython != null && policy.enabled()
            ? new PiperWarmWorker(warmPython,
                TimeUnit.SECONDS.toNanos(policy.idleSeconds())) : null;
    }

    public RuntimeInfo runtime() {
        var policy = runtimeSettings.get();
        PiperWarmWorker current = warmWorker;
        PiperWarmWorker.Metrics metrics = current == null ? null : current.metrics();
        return new RuntimeInfo(warmPython != null, !closed && current != null,
            runtimeSettings.invalid(), policy.idleSeconds(),
            closed ? "CLOSED" : metrics == null ? "DISABLED" : metrics.state(),
            metrics == null ? null : metrics.model(),
            metrics == null ? null : metrics.rssKiB(),
            metrics == null ? 0L : metrics.launched(),
            metrics == null ? 0L : metrics.completed(),
            metrics == null ? 0L : metrics.failed(),
            metrics == null ? 0L : metrics.timedOut(),
            fallbackCount.get(),
            metrics == null ? 0L : metrics.lastStartupMs(),
            metrics == null ? 0L : metrics.lastSynthMs(),
            metrics == null ? 0L : metrics.averageSynthMs());
    }

    /** Administrator policy: Python executable is operator-owned, never accepted via API. */
    public RuntimeInfo configureRuntime(boolean enabled, int idleSeconds)
        throws IOException {
        synchronized (coldLifecycle) {
            if (closed) throw new IllegalStateException("Piper engine closed");
            var next = new PiperRuntimeSettingsStore.Settings(enabled, idleSeconds);
            if (enabled && warmPython == null)
                throw new IllegalArgumentException("Piper Python environment not configured");
            // Only publish a replacement after the previous worker is fully
            // terminated. Holding the lifecycle lock prevents close() from
            // returning before retirement or overlapping two warm workers.
            PiperWarmWorker replacement = enabled
                ? new PiperWarmWorker(warmPython, TimeUnit.SECONDS.toNanos(idleSeconds))
                : null;
            try {
                runtimeSettings.save(next);
                PiperWarmWorker prior = warmWorker;
                if (prior != null) prior.close();
                warmWorker = replacement;
                fallbackCount.set(0);
            } catch (IOException | RuntimeException failure) {
                if (replacement != null) replacement.close();
                throw failure;
            }
        }
        return runtime();
    }

    /** Release resident model without modifying the persisted runtime policy. */
    public void releaseRuntime() {
        PiperWarmWorker current = warmWorker;
        if (current != null) current.invalidate();
    }

    @Override public String id() { return "piper"; }

    @Override public synchronized void invalidateVoiceCatalog() {
        cachedAt = 0;
        PiperWarmWorker current = warmWorker;
        if (current != null) current.invalidate();
    }

    @Override public void close() {
        List<Process> active;
        PiperWarmWorker resident;
        synchronized (coldLifecycle) {
            if (closed) return;
            closed = true;
            active = List.copyOf(activeColdProcesses);
            resident = warmWorker;
            warmWorker = null;
        }
        try {
            for (Process process : active) TtsProcessCleanup.terminate(process);
        } finally {
            if (resident != null) resident.close();
        }
    }

    int activeColdProcessesForProbe() {
        synchronized (coldLifecycle) { return activeColdProcesses.size(); }
    }

    boolean warmWorkerRunning() {
        PiperWarmWorker current = warmWorker;
        return current != null && current.running();
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
                // Managed mode is an explicit allowlist. Legacy mode preserves
                // existing manually installed Piper models until first registration.
                if (packStore != null && !packStore.allowed(stem)) continue;
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
        catalog = immutableOrdered(discovered);
        cachedAt = now;
        return discovered.values().stream().map(ModelVoice::voice).toList();
    }

    /** Preserve explicit filename/speaker order across cached catalog reads. */
    static Map<String, ModelVoice> immutableOrdered(Map<String, ModelVoice> discovered) {
        return Collections.unmodifiableMap(new LinkedHashMap<>(discovered));
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
            names.sort(Comparator.comparingInt(
                (Map.Entry<String, JsonElement> entry) -> speakerId(entry.getValue()))
                .thenComparing(Map.Entry::getKey));
            var seenSpeakers = new HashSet<Integer>();
            for (var entry : names) {
                int number = speakerId(entry.getValue());
                if (number < 0 || number > 255 || result.size() >= 128
                    || !seenSpeakers.add(number)) continue;
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
        // Re-check enabled state and model/config digests at synthesis time.
        // Disabling/removing a pack cannot be bypassed by the 2-minute catalog cache.
        String filename = selected.model().getFileName().toString();
        String stem = filename.substring(0, filename.length() - 5);
        if (packStore != null && !packStore.allowed(stem)) {
            PiperWarmWorker revocationWorker = warmWorker;
            if (revocationWorker != null) revocationWorker.invalidate();
            throw new IllegalArgumentException("Piper voice pack unavailable");
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
        double lengthScale = Math.max(.65, Math.min(1.8,
            1.0 - rate * .045));
        PiperWarmWorker current = warmWorker;
        if (current != null) {
            try {
                return scalePcm16Wav(current.synthesize(
                    selected.model(), selected.config(), text,
                    selected.speaker(), lengthScale), volume);
            } catch (Exception | LinkageError failure) {
                // Shutdown/configuration changes cannot launch a cold fallback.
                if (closed || current.isClosed() || current != warmWorker) {
                    throw new IllegalStateException("Piper engine closed or reconfigured");
                }
                // A crash may fall back only if the model remains authorized.
                current.invalidate();
                if (packStore != null && !packStore.allowed(stem)) {
                    throw new IllegalArgumentException("Piper voice pack unavailable");
                }
                fallbackCount.incrementAndGet();
                System.err.println("[tts] Piper warm worker failed; using cold fallback: "
                    + failure.getClass().getSimpleName());
            }
        }
        // Default one-shot path already checked the managed pack above.
        // Only a warm-worker failure needs a fresh fallback-boundary recheck.
        return synthesizeCold(selected, text, rate, volume, current);
    }

    private byte[] synthesizeCold(ModelVoice selected, String text, int rate,
                                  int volume, PiperWarmWorker fallbackFrom) throws Exception {
        // close() can race with warm-worker fallback before reaching here;
        // the final launch below is always fenced under coldLifecycle.
        if (closed) throw new IllegalStateException("Piper engine closed");
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
            // Test-only latch can pause exactly at the formerly vulnerable
            // warm-to-cold transition. No production delay or retry is added.
            beforeColdLaunch.run();
            // On fallback, validate again after a failed warm attempt. Avoid
            // double-hashing every default one-shot MANAGED request. Never
            // hold the shutdown lock during potentially slow model hashing.
            if (fallbackFrom != null && packStore != null) {
                String name = selected.model().getFileName().toString();
                String stem = name.substring(0, name.length() - 5);
                if (!packStore.allowed(stem)) {
                    throw new IllegalArgumentException("Piper voice pack unavailable");
                }
            }
            Process process;
            synchronized (coldLifecycle) {
                if (closed) throw new IllegalStateException("Piper engine closed");
                // Reconfiguration and cold subprocess launch share the lifecycle lock.
                if (fallbackFrom != null && fallbackFrom != warmWorker)
                    throw new IllegalStateException("Piper worker reconfigured");
                process = new ProcessBuilder(command)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
                activeColdProcesses.add(process);
            }
            try {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                TtsProcessInput.write(process,
                    (text + "\n").getBytes(StandardCharsets.UTF_8), deadline);
                long remaining = TtsProcessInput.remainingNanos(deadline);
                if (remaining == 0 || !process.waitFor(remaining, TimeUnit.NANOSECONDS)) {
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
                try {
                    TtsProcessCleanup.terminate(process);
                } finally {
                    synchronized (coldLifecycle) {
                        activeColdProcesses.remove(process);
                    }
                }
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
