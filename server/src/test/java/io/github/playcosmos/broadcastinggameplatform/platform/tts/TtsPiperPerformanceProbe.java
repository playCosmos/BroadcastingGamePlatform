package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Real Piper ONNX inference benchmark; opt-in CI tool, not a unit test.
 * Measures process-per-synthesis cost, discovered voice latency, VM and
 * best-effort native child RSS on Linux. Never logs speech text or audio.
 */
public final class TtsPiperPerformanceProbe {
    private static final int SAMPLES = 5;
    private static final String MODEL = "en_US-lessac-low";
    private TtsPiperPerformanceProbe() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException(
            "expected <app-root-with-tts/voices> <trusted-model-sha256>");
        Path root = Path.of(args[0]).toAbsolutePath().normalize();
        String trustedHash = args[1];
        if (!trustedHash.matches("[a-fA-F0-9]{64}")) {
            throw new IllegalArgumentException("expected external 64-digit SHA-256");
        }
        var packs = new TtsVoicePackStore(root);
        if (!"LEGACY".equals(packs.mode())) throw new IllegalStateException(
            "benchmark requires fresh dedicated LEGACY root");
        var engine = new PiperEngine(root.resolve("tts/voices"), packs);
        long started = System.nanoTime();
        var voices = engine.voices();
        long coldCatalogMs = millisSince(started);
        if (voices.isEmpty()) throw new IllegalStateException("Piper voice missing");
        String voice = "piper/" + MODEL;
        if (voices.stream().noneMatch(v -> v.id().equals(voice))) {
            throw new IllegalStateException("expected pinned model not discovered");
        }
        started = System.nanoTime();
        engine.voices();
        long warmCatalogMs = millisSince(started);
        System.out.println("PIPER_PERF_CATALOG cold_ms=" + coldCatalogMs
            + " warm_ms=" + warmCatalogMs + " voices=" + voices.size());

        run("legacy", engine, voice);
        packs.register(new TtsVoicePackStore.Registration(
            MODEL, "1.0.0", "MIT", trustedHash, true));
        engine.invalidateVoiceCatalog();
        if (engine.voices().stream().noneMatch(v -> v.id().equals(voice))) {
            throw new IllegalStateException("managed Piper voice missing");
        }
        run("managed", engine, voice);
        if (!"MANAGED".equals(packs.mode())
            || !packs.verify(MODEL).match()) {
            throw new IllegalStateException("managed benchmark checksum validation failed");
        }
        System.out.println("PIPER_PERF_COMPLETE real_model=" + MODEL
            + " samples_per_mode=" + SAMPLES);
    }

    private static void run(String mode, PiperEngine engine, String voice)
        throws Exception {
        var timings = new ArrayList<Long>();
        long peakHeapBytes = 0;
        long peakJvmRssKiB = 0;
        try (var sampler = new NativeSampler();
             var service = new TtsService(List.of(engine))) {
            for (int i = 0; i < SAMPLES; i++) {
                // Short natural utterances minimize variability from text duration.
                String sample = "Hello, this is a short speech benchmark sample number "
                    + (i + 1) + ".";
                long begin = System.nanoTime();
                var task = service.enqueue(new TtsService.Request(sample, voice, 0, 80));
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
                while (System.nanoTime() < deadline) {
                    var job = service.job(task.id());
                    if (job == null || "FAILED".equals(job.status())
                        || "CANCELLED".equals(job.status())) {
                        throw new IllegalStateException("Piper sample failed");
                    }
                    if ("READY".equals(job.status())) break;
                    Thread.sleep(10);
                }
                if (!"READY".equals(service.job(task.id()).status())) {
                    throw new IllegalStateException("Piper benchmark timed out");
                }
                long elapsed = millisSince(begin);
                byte[] wav = service.audio(task.id());
                if (wav == null || wav.length < 1000) {
                    throw new IllegalStateException("invalid real Piper WAV");
                }
                timings.add(elapsed);
                Runtime vm = Runtime.getRuntime();
                peakHeapBytes = Math.max(peakHeapBytes,
                    vm.totalMemory() - vm.freeMemory());
                peakJvmRssKiB = Math.max(peakJvmRssKiB,
                    procResidentKiB(ProcessHandle.current().pid()));
            }
            var stats = service.status();
            if (stats.engineSyntheses() != SAMPLES
                || stats.previewReuses() != 0
                || stats.synthesisFailures() != 0) {
                throw new IllegalStateException("Piper benchmark reuse or failures unexpected");
            }
            long[] ordered = timings.stream().mapToLong(Long::longValue).sorted().toArray();
            // p50/p95 are sample order statistics only: CI hardware varies.
            long p50 = ordered[(int)Math.ceil(SAMPLES * .50) - 1];
            long p95 = ordered[(int)Math.ceil(SAMPLES * .95) - 1];
            long sum = Arrays.stream(ordered).sum();
            System.out.println("PIPER_PERF_RESULT mode=" + mode
                + " samples=" + SAMPLES + " first_ms=" + timings.getFirst()
                + " median_ms=" + p50 + " p95_ms=" + p95
                + " mean_ms=" + sum / SAMPLES
                + " min_ms=" + ordered[0] + " max_ms=" + ordered[ordered.length - 1]
                + " jvm_peak_used_heap_kib=" + peakHeapBytes / 1024
                + " jvm_peak_rss_kib=" + Math.max(peakJvmRssKiB,
                    sampler.peakJvmRssKiB)
                + " child_peak_rss_kib=" + sampler.peakChildRssKiB
                + " retained_audio_kib=" + stats.retainedAudioBytes() / 1024);
        }
    }

    private static long millisSince(long start) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
    }

    private static long procResidentKiB(long pid) {
        try {
            for (String line : Files.readAllLines(
                Path.of("/proc", Long.toString(pid), "status"), StandardCharsets.UTF_8)) {
                if (line.startsWith("VmRSS:")) {
                    return Long.parseLong(line.substring(6).trim().split("\\s+")[0]);
                }
            }
        } catch (Exception ignored) { /* missing procfs is expected elsewhere */ }
        return 0;
    }

    private static final class NativeSampler implements AutoCloseable {
        private final AtomicBoolean active = new AtomicBoolean(true);
        private final Thread thread;
        private volatile long peakChildRssKiB;
        private volatile long peakJvmRssKiB;

        NativeSampler() {
            thread = Thread.ofVirtual().name("piper-benchmark-rss").start(() -> {
                while (active.get()) {
                    peakJvmRssKiB = Math.max(peakJvmRssKiB,
                        procResidentKiB(ProcessHandle.current().pid()));
                    long currentChildrenKiB = 0;
                    for (var child : ProcessHandle.current().descendants().toList()) {
                        currentChildrenKiB += procResidentKiB(child.pid());
                    }
                    peakChildRssKiB = Math.max(peakChildRssKiB, currentChildrenKiB);
                    try { Thread.sleep(15); }
                    catch (InterruptedException interrupted) { break; }
                }
            });
        }

        @Override public void close() throws InterruptedException {
            active.set(false);
            thread.interrupt();
            thread.join(1000);
        }
    }
}
