package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Optional real-model Piper worker validation on an isolated CI runner only. */
public final class TtsPiperWarmProbe {
    private TtsPiperWarmProbe() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException(
            "expected app-root python-executable external-model-SHA256");
        Path root = Path.of(args[0]).toAbsolutePath().normalize();
        Path python = Path.of(args[1]).toAbsolutePath().normalize();
        Path model = root.resolve("tts/voices/en_US-lessac-low.onnx");
        Path config = root.resolve("tts/voices/en_US-lessac-low.onnx.json");
        String voice = "piper/en_US-lessac-low";
        var store = new TtsVoicePackStore(root);
        require("LEGACY".equals(store.mode()), "probe needs a dedicated app root");

        // Lifecycle and framing: multiple real requests must produce distinct,
        // correctly bounded WAVs from the same one-model process.
        try (var worker = new PiperWarmWorker(
            python, TimeUnit.MILLISECONDS.toNanos(200))) {
            long cold = System.nanoTime();
            byte[] one = worker.synthesize(model, config, "Hello world.", null, 1.0);
            cold = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - cold);
            require(validWav(one), "first warm WAV must be complete");
            require(worker.running(), "model must remain loaded after first WAV");
            long repeated = System.nanoTime();
            for (int i = 0; i < 100; i++) {
                byte[] result = worker.synthesize(model, config,
                    "Hello world number " + i + ".", null, 1.0);
                require(validWav(result), "repeat " + i + " invalid WAV framing");
            }
            repeated = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - repeated);
            require(worker.running(), "worker must serve 100 requests without restart");
            worker.crashForProbe();
            byte[] restarted = worker.synthesize(model, config,
                "Recover after process crash.", null, 1.0);
            require(validWav(restarted) && worker.running(),
                "crash must create a new healthy child process");
            Thread.sleep(1500);
            require(!worker.running(), "idle model must exit automatically");
            byte[] awakened = worker.synthesize(model, config,
                "Restart after idle.", null, 1.0);
            require(validWav(awakened), "idle restart must synthesize normally");
            System.out.println("PIPER_WARM_PROTOCOL_PASSED requests=100 first_ms="
                + cold + " repeats_total_ms=" + repeated);
        }

        // Model registry integration and strict revocation before each call.
        store.register(new TtsVoicePackStore.Registration(
            "en_US-lessac-low", "1.0", "MIT", args[2], true));
        String originalConfig = Files.readString(config, StandardCharsets.UTF_8);
        var engine = new PiperEngine(root.resolve("tts/voices"), store, python);
        try (var service = new TtsService(List.of(engine))) {
            require(engine.voices().stream().anyMatch(v -> voice.equals(v.id())),
                "managed local voice must be discoverable");
            var first = service.enqueue(new TtsService.Request(
                "Managed worker speech.", voice, 0, 80));
            waitFor(service, first.id(), "READY");
            require(engine.warmWorkerRunning(),
                "managed synthesis should retain a single resident model");
            Files.writeString(config, originalConfig + " ", StandardCharsets.UTF_8);
            var revoked = service.enqueue(new TtsService.Request(
                "Should fail before synthesis.", voice, 0, 80));
            waitFor(service, revoked.id(), "FAILED");
            require(!engine.warmWorkerRunning(),
                "modified config must immediately evict resident model");
            Files.writeString(config, originalConfig, StandardCharsets.UTF_8);
            var restored = service.enqueue(new TtsService.Request(
                "Restored trusted voice.", voice, -2, 40));
            waitFor(service, restored.id(), "READY");
            require(engine.warmWorkerRunning(), "restored model can be reloaded");
            store.setEnabled("en_US-lessac-low", false);
            var disabled = service.enqueue(new TtsService.Request(
                "Disabled voice.", voice, 0, 80));
            waitFor(service, disabled.id(), "FAILED");
            require(!engine.warmWorkerRunning(), "disabled pack must evict model");
            store.setEnabled("en_US-lessac-low", true);
        }
        require(!engine.warmWorkerRunning(), "service close must release Piper child");

        // A broken optional Python executable must fail back to known-good
        // one-shot Piper CLI rather than lose administrator speech.
        String javaExecutable = Path.of(System.getProperty("java.home"),
            "bin", System.getProperty("os.name", "").toLowerCase().contains("win")
                ? "java.exe" : "java").toString();
        try (var failing = new PiperEngine(root.resolve("tts/voices"), store,
                Path.of(javaExecutable));
             var tts = new TtsService(List.of(failing))) {
            var response = tts.enqueue(new TtsService.Request(
                "Fallback speech must still work.", voice, 0, 80));
            waitFor(tts, response.id(), "READY");
            require(tts.audio(response.id()) != null,
                "cold CLI fallback must return valid audio");
            require(!failing.warmWorkerRunning(), "bad warm process cannot linger");
        }

        verifyChildTreeCleanup(root, python, model, config);
        verifyNoColdLaunchAfterClose(root, store, voice, javaExecutable);

        System.out.println("PIPER_WARM_LIFECYCLE_PASSED revocation=true"
            + " idle_exit=true crash_restart=true fallback=true"
            + " descendant_cleanup=true cold_shutdown_fenced=true");
    }

    /** Regression: Python launches an inherited-stdio child before close(). */
    private static void verifyChildTreeCleanup(Path root, Path python, Path model,
                                                Path config) throws Exception {
        Path wrapper = Files.createTempFile(root, "tts-python-tree-", ".sh");
        String escaped = python.toString().replace("'", "'\"'\"'");
        Files.writeString(wrapper, "#!/bin/sh\nsleep 90 &\nexec '" + escaped
            + "' \"$@\"\n", StandardCharsets.UTF_8);
        require(wrapper.toFile().setExecutable(true), "test wrapper must be executable");
        List<ProcessHandle> children = List.of();
        try (var worker = new PiperWarmWorker(wrapper)) {
            require(validWav(worker.synthesize(model, config,
                "The process tree should close.", null, 1.0)),
                "tree-test Piper must return a real WAV");
            long pid = worker.processIdForProbe();
            require(pid > 0, "tree-test parent missing");
            children = ProcessHandle.of(pid).orElseThrow().descendants().toList();
            require(!children.isEmpty(), "tree-test did not spawn its inherited child");
            worker.close();
            for (var child : children) {
                require(!child.isAlive(), "tree-test orphan child survived shutdown");
            }
        } finally {
            for (var child : children) {
                if (child.isAlive()) child.destroyForcibly();
            }
            Files.deleteIfExists(wrapper);
        }
        System.out.println("PIPER_WARM_CHILD_TREE_PASSED");
    }

    /** Regression: close() lands exactly between warm failure and cold launch. */
    private static void verifyNoColdLaunchAfterClose(Path root,
            TtsVoicePackStore store, String voice, String javaExecutable)
            throws Exception {
        CountDownLatch atColdLaunch = new CountDownLatch(1);
        CountDownLatch resume = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Runnable gate = () -> {
            atColdLaunch.countDown();
            try {
                if (!resume.await(10, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("cold launch gate timed out");
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("cold launch gate interrupted", interrupted);
            }
        };
        try (var engine = new PiperEngine(root.resolve("tts/voices"), store,
                 Path.of(javaExecutable), gate)) {
            require(engine.voices().stream().anyMatch(v -> voice.equals(v.id())),
                "fallback race must discover the managed voice");
            Thread caller = Thread.ofVirtual().start(() -> {
                try {
                    engine.synthesize(voice, "Close before cold fallback.", 0, 80);
                } catch (Throwable error) { failure.set(error); }
            });
            try {
                require(atColdLaunch.await(20, TimeUnit.SECONDS),
                    "failed warm process did not reach cold fallback");
                engine.close();
            } finally {
                resume.countDown();
            }
            caller.join(5000);
            require(!caller.isAlive(), "cold fallback was not terminated");
            require(failure.get() instanceof IllegalStateException
                && failure.get().getMessage().contains("closed"),
                "closed engine attempted a cold fallback");
            require(engine.activeColdProcessesForProbe() == 0,
                "closed engine retained a cold child process");
        }
        System.out.println("PIPER_COLD_SHUTDOWN_RACE_PASSED");
    }

    private static boolean validWav(byte[] wav) {
        if (wav == null || wav.length < 46
            || wav[0] != 'R' || wav[1] != 'I' || wav[2] != 'F' || wav[3] != 'F'
            || wav[8] != 'W' || wav[9] != 'A' || wav[10] != 'V' || wav[11] != 'E')
            return false;
        int declared = (wav[4] & 255) | ((wav[5] & 255) << 8)
            | ((wav[6] & 255) << 16) | ((wav[7] & 255) << 24);
        return declared + 8 == wav.length;
    }

    private static void waitFor(TtsService service, String id, String status)
        throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        while (System.nanoTime() < deadline) {
            var state = service.job(id);
            if (state != null && status.equals(state.status())) return;
            if (state == null || ("FAILED".equals(state.status())
                && !"FAILED".equals(status))) {
                throw new IllegalStateException("Piper worker job failed: "
                    + (state == null ? "missing" : state.error()));
            }
            Thread.sleep(15);
        }
        throw new IllegalStateException("Piper worker status timed out: " + status);
    }

    private static void require(boolean ok, String message) {
        if (!ok) throw new IllegalStateException(message);
    }
}
