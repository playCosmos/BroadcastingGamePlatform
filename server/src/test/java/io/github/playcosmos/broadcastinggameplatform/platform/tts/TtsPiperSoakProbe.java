package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Real pinned Piper ONNX soak, intentionally not part of fast regression probes.
 * Linux CI samples /proc RSS; never persists synthesis text, PCM or transcripts.
 */
public final class TtsPiperSoakProbe {
    private static final int REPEATS = 1000;
    private TtsPiperSoakProbe() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 2)
            throw new IllegalArgumentException("expected app-root and Python binary");
        Path root = Path.of(args[0]).toAbsolutePath().normalize();
        Path python = Path.of(args[1]).toAbsolutePath().normalize();
        Path voices = root.resolve("tts/voices");
        Path first = voices.resolve("en_US-lessac-low.onnx");
        Path firstConfig = voices.resolve("en_US-lessac-low.onnx.json");
        Path second = voices.resolve("en_US-lessac-low-copy.onnx");
        Path secondConfig = voices.resolve("en_US-lessac-low-copy.onnx.json");
        // The second filename exercises real switch/load/unload rather than a
        // simulated selection. Identical ONNX data avoids another download.
        Files.copy(first, second, StandardCopyOption.REPLACE_EXISTING);
        Files.copy(firstConfig, secondConfig, StandardCopyOption.REPLACE_EXISTING);
        var rssSamples = new ArrayList<Long>();
        var retainedHeapSamples = new ArrayList<Long>();
        long firstPid = -1;
        long baselineRss = -1;
        long totalStart = System.nanoTime();
        try {
            try (var worker = new PiperWarmWorker(python)) {
                long elapsed = System.nanoTime();
                for (int i = 0; i < REPEATS; i++) {
                    byte[] wav = worker.synthesize(first, firstConfig,
                        "Piper reliability soak test number " + (i % 10) + ".",
                        null, 1.0);
                    require(wav.length > 1000 && wav[0] == 'R' && wav[1] == 'I',
                        "invalid real WAV at request " + i);
                    long pid = worker.processIdForProbe();
                    require(pid > 0, "Piper subprocess must stay resident");
                    if (i == 0) firstPid = pid;
                    require(pid == firstPid, "the one-model worker restarted unexpectedly");
                    if ((i + 1) % 100 == 0) {
                        long rss = residentKiB(pid);
                        require(rss > 0, "Linux /proc resident-size check unavailable");
                        rssSamples.add(rss);
                        // The JVM may commit and retain clean heap pages even
                        // when no objects are leaking. Distinguish RSS from
                        // live retained objects with test-only forced GC.
                        System.gc();
                        long heapAfterGc = Runtime.getRuntime().totalMemory()
                            - Runtime.getRuntime().freeMemory();
                        retainedHeapSamples.add(heapAfterGc / 1024);
                        if (i == 99) baselineRss = rss;
                        // This is a coarse runaway-growth guard for the pinned
                        // ~220MiB fixture, not a universal model memory ceiling.
                        require(rss <= baselineRss + 64L * 1024,
                            "native Piper RSS grew >64MiB above warm baseline");
                        require(retainedHeapSamples.getLast()
                            <= retainedHeapSamples.getFirst() + 32L * 1024,
                            "post-GC JVM live heap grew >32MiB since warm baseline");
                        System.out.println("PIPER_SOAK_SAMPLE requests=" + (i + 1)
                            + " child_rss_kib=" + rss
                            + " jvm_rss_kib=" + residentKiB(ProcessHandle.current().pid())
                            + " jvm_post_gc_used_heap_kib=" + heapAfterGc / 1024);
                    }
                }
                elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - elapsed);
                require(rssSamples.size() == 10, "ten RSS observations required");

                byte[] switched = worker.synthesize(second, secondConfig,
                    "Testing model switch.", null, 1.0);
                long secondPid = worker.processIdForProbe();
                require(switched.length > 1000 && secondPid > 0 && secondPid != firstPid,
                    "model switch must start a distinct process");
                require(!alive(firstPid), "old model process remains after switch");
                require(worker.synthesize(first, firstConfig,
                    "Return to the original model.", null, 1.0).length > 1000,
                    "return-to-original model failed");
                long thirdPid = worker.processIdForProbe();
                require(thirdPid != firstPid && thirdPid != secondPid,
                    "switch back must replace resident child");
                require(!alive(secondPid), "previous model process remains after switch");

                worker.crashForProbe();
                require(!alive(thirdPid), "forced crash should terminate subprocess");
                require(worker.synthesize(first, firstConfig,
                    "Recover after crash.", null, 1.0).length > 1000,
                    "crash recovery must produce real audio");
                require(worker.processIdForProbe() != thirdPid,
                    "crash recovery must launch fresh process");
                long lastPid = worker.processIdForProbe();
                System.out.println("PIPER_SOAK_RESULT requests=" + REPEATS
                    + " total_ms=" + elapsed
                    + " child_first_rss_kib=" + rssSamples.getFirst()
                    + " child_last_rss_kib=" + rssSamples.getLast()
                    + " child_peak_observed_rss_kib="
                    + rssSamples.stream().mapToLong(Long::longValue).max().orElse(0)
                    + " jvm_first_post_gc_used_heap_kib="
                    + retainedHeapSamples.getFirst()
                    + " jvm_last_post_gc_used_heap_kib="
                    + retainedHeapSamples.getLast()
                    + " model_switches=2 crash_recovery=true");
                worker.close();
                require(!alive(lastPid), "close must reap last model subprocess");
            }

            // Verify interruption while synthesis is actually in flight;
            // closing TTS must never launch a replacement process.
            var inFlight = new PiperWarmWorker(python);
            long pid;
            try {
                inFlight.synthesize(first, firstConfig, "Load model.", null, 1.0);
                pid = inFlight.processIdForProbe();
                AtomicReference<Throwable> aborted = new AtomicReference<>();
                Thread task = Thread.ofVirtual().name("tts-soak-inflight").start(() -> {
                    try {
                        inFlight.synthesize(first, firstConfig,
                            "This long sentence verifies interrupted inference. ".repeat(34),
                            null, 1.0);
                    } catch (Throwable error) { aborted.set(error); }
                });
                Thread.sleep(250);
                long start = System.nanoTime();
                inFlight.close();
                long closeMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
                task.join(5000);
                require(!task.isAlive(), "close must end in-flight synthesis promptly");
                require(aborted.get() != null,
                    "long-running native synthesis should be cancelled by close");
                require(closeMs < 5000, "close must not wait for 30-second deadline");
                require(!alive(pid), "in-flight child survived service close");
                System.out.println("PIPER_SOAK_INTERRUPT_PASSED close_ms=" + closeMs);
            } finally {
                inFlight.close();
            }

            // Startup timeout is isolated from production's 30-second limit
            // by injecting a deliberately tiny deadline in this test only.
            try (var deadlineWorker = new PiperWarmWorker(
                python, PiperWarmWorker.IDLE_NANOS, TimeUnit.MILLISECONDS.toNanos(5))) {
                boolean timedOut = false;
                try {
                    deadlineWorker.synthesize(first, firstConfig,
                        "Timeout probe.", null, 1.0);
                } catch (Exception expected) { timedOut = true; }
                require(timedOut && !deadlineWorker.running(),
                    "startup timeout must kill and discard partial subprocess");
                System.out.println("PIPER_SOAK_TIMEOUT_PASSED");
            }
            System.out.println("PIPER_SOAK_COMPLETE end_to_end_ms="
                + TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - totalStart));
        } finally {
            Files.deleteIfExists(second);
            Files.deleteIfExists(secondConfig);
        }
    }

    private static long residentKiB(long pid) {
        try {
            for (String line : Files.readAllLines(Path.of(
                "/proc", Long.toString(pid), "status"), StandardCharsets.UTF_8)) {
                if (line.startsWith("VmRSS:")) {
                    return Long.parseLong(line.substring(6).trim().split("\\s+")[0]);
                }
            }
        } catch (Exception ignored) { /* Linux-only test runner */ }
        return 0L;
    }

    private static boolean alive(long pid) {
        return pid > 0 && ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);
    }

    private static void require(boolean passed, String description) {
        if (!passed) throw new IllegalStateException(description);
    }
}
