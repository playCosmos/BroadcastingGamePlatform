package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Platform TTS core regression probe: no speech engines or Windows APIs needed. */
public final class TtsServiceProbe {
    private TtsServiceProbe() {}

    public static void main(String[] args) throws Exception {
        var first = new MockEngine("engine-a", "한국어 A");
        var second = new MockEngine("engine-b", "한국어 B");
        try (var tts = new TtsService(List.of(first, second))) {
            var catalog = tts.voices();
            require(catalog.size() == 2, "multiple engine voices must be listed");
            require(catalog.get(0).id().equals("engine-a/한국어 A"),
                "voice IDs must be stable per engine");
            require(catalog.get(1).id().equals("engine-b/한국어 B"),
                "second engine must be available without core changes");
            for (var invalid : List.of(
                new TtsService.Request("", catalog.get(0).id(), 0, 80),
                new TtsService.Request("가".repeat(201), catalog.get(0).id(), 0, 80),
                new TtsService.Request("hello", "unregistered/voice", 0, 80),
                new TtsService.Request("hello", catalog.get(0).id(), 11, 80),
                new TtsService.Request("hello", catalog.get(0).id(), 0, 101)
            )) {
                boolean rejected = false;
                try { tts.enqueue(invalid); }
                catch (IllegalArgumentException expected) { rejected = true; }
                require(rejected, "invalid request should be rejected");
            }
            TtsService.Job jobA = tts.enqueue(new TtsService.Request(
                "안녕하세요", catalog.get(0).id(), -1, 85
            ));
            TtsService.Job jobB = tts.enqueue(new TtsService.Request(
                "목소리 B", catalog.get(1).id(), 2, 65
            ));
            waitFor(tts, jobA.id(), "READY");
            waitFor(tts, jobB.id(), "READY");
            require(first.calls.get() == 1 && second.calls.get() == 1,
                "both providers must synthesize exactly once");
            require(tts.audio(jobA.id()).length >= 44, "preview WAV should be retained");
            byte[] wav = tts.audio(jobA.id());
            wav[0] = 0;
            require(tts.audio(jobA.id())[0] == 'R', "audio output must be defensive copy");
            require(tts.status().queued() == 0, "queue should finish");

            var block = new BlockingEngine();
            try (var queued = new TtsService(List.of(block))) {
                String voiceId = queued.voices().getFirst().id();
                var active = queued.enqueue(new TtsService.Request("first", voiceId, 0, 80));
                require(block.started.await(2, TimeUnit.SECONDS),
                    "first request must enter synthesis");
                var cancelled = queued.enqueue(new TtsService.Request("second", voiceId, 0, 80));
                require(queued.clearQueued() == 1, "clear should remove only waiting work");
                require("CANCELLED".equals(queued.job(cancelled.id()).status()),
                    "queued request must be cancelled");
                block.release.countDown();
                waitFor(queued, active.id(), "READY");
                require(block.calls.get() == 1, "cancelled audio must not synthesize");
            }
        }
        try (var wavService = new TtsService(List.of(new CorruptWavEngine()))) {
            String voiceId = wavService.voices().getFirst().id();
            for (String malformed : List.of(
                "missing WAVE", "oversized chunk", "bad RIFF size",
                "missing fmt", "empty audio", "no channels", "no sample rate",
                "no byte rate")) {
                var rejected = wavService.enqueue(new TtsService.Request(
                    malformed, voiceId, 0, 80));
                waitFor(wavService, rejected.id(), "FAILED");
                require(wavService.audio(rejected.id()) == null,
                    "corrupted WAV must never become available");
            }
        }
        // Large but valid WAV previews must not accumulate without a byte cap.
        var bigVoice = new LargeWavEngine();
        try (var bounded = new TtsService(List.of(bigVoice))) {
            String voiceId = bounded.voices().getFirst().id();
            var ids = new java.util.ArrayList<String>();
            for (int i = 0; i < 5; i++) {
                var next = bounded.enqueue(new TtsService.Request(
                    "large " + i, voiceId, 0, 80));
                ids.add(next.id());
                waitFor(bounded, next.id(), "READY");
                var stats = bounded.status();
                require(stats.retainedAudioBytes() <= stats.maxRetainedAudioBytes(),
                    "retained preview bytes must stay within the total cap");
            }
            var stats = bounded.status();
            require(stats.maxRetainedAudioBytes() == 16 * 1024 * 1024,
                "preview cache must have a 16 MiB hard cap");
            require(stats.retainedJobs() == 5,
                "evicting preview bytes must preserve job status records");
            for (int i = 0; i < 2; i++) {
                require("EXPIRED".equals(bounded.job(ids.get(i)).status())
                    && !bounded.job(ids.get(i)).audioAvailable()
                    && bounded.audio(ids.get(i)) == null,
                    "oldest large previews must expire without exposing audio");
            }
            for (int i = 2; i < ids.size(); i++) {
                require("READY".equals(bounded.job(ids.get(i)).status())
                    && bounded.job(ids.get(i)).audioAvailable(),
                    "newer previews must remain playable");
            }
            require(stats.retainedAudioBytes() == 3 * (4 * 1024 * 1024 + 44),
                "byte accounting must match three retained large WAV files");
            // Pruning old terminal job records must also refund their byte cost.
            for (int i = 0; i < 25; i++) {
                var next = bounded.enqueue(new TtsService.Request(
                    "small " + i, voiceId, 0, 80));
                waitFor(bounded, next.id(), "READY");
            }
            stats = bounded.status();
            require(stats.retainedJobs() <= 24,
                "completed job metadata must also remain bounded");
            require(stats.retainedAudioBytes() <= stats.maxRetainedAudioBytes(),
                "cache usage must stay bounded after metadata pruning");
            int observedBytes = 0;
            for (String id : ids) {
                byte[] available = bounded.audio(id);
                if (available != null) observedBytes += available.length;
            }
            require(stats.retainedAudioBytes() >= observedBytes,
                "cache accounting must not undercount retained previews");
        }
        // A synthetic monotonic clock tests retention without sleeping for 15 minutes.
        var clockNanos = new java.util.concurrent.atomic.AtomicLong(
            TimeUnit.SECONDS.toNanos(1));
        try (var timed = new TtsService(
            List.of(new MockEngine("ttl", "Timed")), null, clockNanos::get)) {
            String voiceId = timed.voices().getFirst().id();
            var preview = timed.enqueue(new TtsService.Request(
                "time-based retention", voiceId, 0, 80));
            waitFor(timed, preview.id(), "READY");
            int initialBytes = timed.status().retainedAudioBytes();
            require(initialBytes == sampleWav().length,
                "newly synthesized preview must be accounted for");
            clockNanos.addAndGet(TimeUnit.MINUTES.toNanos(15)
                - TimeUnit.SECONDS.toNanos(1));
            require("READY".equals(timed.job(preview.id()).status())
                && timed.audio(preview.id()) != null,
                "preview must remain playable before its 15-minute deadline");
            clockNanos.addAndGet(TimeUnit.SECONDS.toNanos(1));
            var expired = timed.job(preview.id());
            require("EXPIRED".equals(expired.status())
                && !expired.audioAvailable()
                && timed.audio(preview.id()) == null,
                "expired preview must be unavailable at the time boundary");
            require(timed.status().retainedAudioBytes() == 0,
                "time expiration must refund the WAV cache byte total");
            require(timed.status().retainedJobs() == 1,
                "time expiration must preserve the job record");
            require(expired.error() != null
                && !expired.error().contains("time-based retention"),
                "expiry must not expose original synthesis text");
            var fresh = timed.enqueue(new TtsService.Request(
                "fresh preview", voiceId, 0, 80));
            waitFor(timed, fresh.id(), "READY");
            require(timed.audio(fresh.id()) != null,
                "expiry of previous audio must not affect fresh previews");
        }
        // Audio retention starts on completion, not when the job was enqueued.
        var delayedClock = new java.util.concurrent.atomic.AtomicLong(1234);
        var delayedEngine = new BlockingEngine();
        try (var delayed = new TtsService(
            List.of(delayedEngine), null, delayedClock::get)) {
            String voiceId = delayed.voices().getFirst().id();
            var queuedBeforeLongWait = delayed.enqueue(new TtsService.Request(
                "waited for synthesis", voiceId, 0, 80));
            require(delayedEngine.started.await(2, TimeUnit.SECONDS),
                "delayed preview must enter synthesis");
            delayedClock.addAndGet(TimeUnit.MINUTES.toNanos(60));
            delayedEngine.release.countDown();
            waitFor(delayed, queuedBeforeLongWait.id(), "READY");
            require(delayed.audio(queuedBeforeLongWait.id()) != null,
                "a long queue/synthesis delay must not expire new audio");
            delayedClock.addAndGet(TimeUnit.MINUTES.toNanos(15));
            require("EXPIRED".equals(delayed.job(queuedBeforeLongWait.id()).status()),
                "preview expiration must use synthesis completion age");
        } finally {
            delayedEngine.release.countDown();
        }
        // Shutdown must reject new requests and discard outstanding speech.
        var shutdownEngine = new BlockingEngine();
        var shutdown = new TtsService(List.of(shutdownEngine));
        String shutdownVoice = shutdown.voices().getFirst().id();
        var inFlight = shutdown.enqueue(new TtsService.Request(
            "active at shutdown", shutdownVoice, 0, 80));
        require(shutdownEngine.started.await(2, TimeUnit.SECONDS),
            "shutdown test must begin synthesis");
        var waiting = shutdown.enqueue(new TtsService.Request(
            "queued at shutdown", shutdownVoice, 0, 80));
        shutdown.close();
        require(shutdown.audio(inFlight.id()) == null && shutdown.audio(waiting.id()) == null,
            "shutdown must not expose pending or active audio");
        boolean closedRejected = false;
        try {
            shutdown.enqueue(new TtsService.Request("after close", shutdownVoice, 0, 80));
        } catch (IllegalStateException expected) { closedRejected = true; }
        require(closedRejected, "closed service must reject enqueue");
        shutdownEngine.release.countDown();
        // An optional provider can return duplicate/malformed IDs or fail on refresh.
        // Neither condition may poison the combined catalog or administrator API.
        TtsService.TtsEngine faulty = new TtsService.TtsEngine() {
            @Override public String id() { return "unstable"; }
            @Override public List<TtsService.Voice> voices() {
                return List.of(
                    new TtsService.Voice("unstable/valid", "unstable", "Valid", "ko-KR"),
                    new TtsService.Voice("unstable/valid", "unstable", "Duplicate", "ko-KR"),
                    new TtsService.Voice("other/invalid", "unstable", "Wrong prefix", "ko-KR"),
                    new TtsService.Voice("unstable/", "unstable", "Empty suffix", "ko-KR")
                );
            }
            @Override public void invalidateVoiceCatalog() {
                throw new IllegalStateException("optional provider refresh failed");
            }
            @Override public byte[] synthesize(
                String voiceId, String text, int rate, int volume
            ) { return new byte[44]; }
        };
        try (var catalogGuard = new TtsService(List.of(faulty, new MockEngine("healthy", "Voice")))) {
            require(catalogGuard.voices().size() == 2,
                "duplicate and malformed voice IDs must be filtered");
            require(catalogGuard.refreshVoices().size() == 2,
                "optional engine refresh failure must not hide healthy voices");
        }
        // A missing native library must not disable healthy voice engines.
        TtsService.TtsEngine badCatalog = new TtsService.TtsEngine() {
            @Override public String id() { return "native-catalog"; }
            @Override public List<TtsService.Voice> voices() {
                throw new UnsatisfiedLinkError("unavailable native catalog");
            }
            @Override public void invalidateVoiceCatalog() {
                throw new ExceptionInInitializerError("unavailable native refresh");
            }
            @Override public byte[] synthesize(
                String voiceId, String text, int rate, int volume) {
                throw new AssertionError("catalog engine must not synthesize");
            }
        };
        try (var robustCatalog = new TtsService(List.of(
            badCatalog, new MockEngine("catalog-healthy", "OK")))) {
            require(robustCatalog.voices().size() == 1,
                "missing native catalog must not hide healthy voices");
            require(robustCatalog.refreshVoices().size() == 1,
                "native refresh failure must not hide healthy voices");
        }
        TtsService.TtsEngine nativeFailure = new TtsService.TtsEngine() {
            @Override public String id() { return "native-failure"; }
            @Override public List<TtsService.Voice> voices() {
                return List.of(new TtsService.Voice(
                    "native-failure/default", "native-failure", "Native", "ko-KR"));
            }
            @Override public byte[] synthesize(
                String voiceId, String text, int rate, int volume) {
                throw new UnsatisfiedLinkError("sensitive native failure details");
            }
        };
        try (var recovery = new TtsService(List.of(
            nativeFailure, new MockEngine("recovered", "OK")))) {
            var failedJob = recovery.enqueue(new TtsService.Request(
                "private sample", "native-failure/default", 0, 80));
            var nextJob = recovery.enqueue(new TtsService.Request(
                "next request", "recovered/OK", 0, 80));
            waitFor(recovery, failedJob.id(), "FAILED");
            waitFor(recovery, nextJob.id(), "READY");
            require(recovery.audio(failedJob.id()) == null,
                "native synthesis failure must not expose audio");
            require(!recovery.job(failedJob.id()).error().contains("sensitive")
                && !recovery.job(failedJob.id()).error().contains("private"),
                "backend error details and speech text must not reach admin response");
        }
        // Exercise cleanup with the current JDK, without installing any TTS engine.
        String javaExe = java.nio.file.Path.of(System.getProperty("java.home"),
            "bin", System.getProperty("os.name", "").toLowerCase().contains("win")
                ? "java.exe" : "java").toString();
        Process sleeping = new ProcessBuilder(javaExe, "-cp",
            System.getProperty("java.class.path"),
            SleepProcess.class.getName()).start();
        try {
            require(sleeping.isAlive(), "cleanup probe child should be alive");
            TtsProcessCleanup.terminate(sleeping);
            require(!sleeping.isAlive(), "cleanup must terminate a live child");
            // Repeated termination must also be safe.
            TtsProcessCleanup.terminate(sleeping);
        } finally {
            TtsProcessCleanup.terminate(sleeping);
        }
        Process parent = new ProcessBuilder(javaExe, "-cp",
            System.getProperty("java.class.path"),
            SpawnProcess.class.getName())
            .redirectError(ProcessBuilder.Redirect.DISCARD)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
        ProcessHandle descendant = null;
        try {
            long startupDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (descendant == null && System.nanoTime() < startupDeadline) {
                descendant = parent.toHandle().descendants().findFirst().orElse(null);
                if (descendant == null) Thread.sleep(25);
            }
            require(descendant != null && descendant.isAlive(),
                "subprocess tree probe must observe a running grandchild");
            TtsProcessCleanup.terminate(parent);
            require(!parent.isAlive() && !descendant.isAlive(),
                "subprocess cleanup must terminate parent and its descendants");
        } finally {
            TtsProcessCleanup.terminate(parent);
            if (descendant != null && descendant.isAlive())
                descendant.destroyForcibly();
        }
        // A child that never reads stdin must not block the TTS worker forever.
        Process blockedInput = new ProcessBuilder(javaExe, "-cp",
            System.getProperty("java.class.path"),
            SleepProcess.class.getName()).start();
        long inputStart = System.nanoTime();
        try {
            boolean timedOut = false;
            try {
                TtsProcessInput.write(blockedInput, new byte[8 * 1024 * 1024],
                    System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(800));
            } catch (IllegalStateException expected) {
                timedOut = expected.getMessage().contains("timeout");
            }
            require(timedOut, "blocked subprocess stdin must time out");
            require(!blockedInput.isAlive(), "stdin timeout must terminate child");
            require(System.nanoTime() - inputStart < TimeUnit.SECONDS.toNanos(5),
                "stdin timeout must finish within a bounded interval");
        } finally {
            TtsProcessCleanup.terminate(blockedInput);
        }
        Process readingInput = new ProcessBuilder(javaExe, "-cp",
            System.getProperty("java.class.path"),
            ReadProcess.class.getName()).start();
        try {
            TtsProcessInput.write(readingInput, "hello\\n".getBytes(
                java.nio.charset.StandardCharsets.UTF_8),
                System.nanoTime() + TimeUnit.SECONDS.toNanos(5));
            require(readingInput.waitFor(5, TimeUnit.SECONDS)
                && readingInput.exitValue() == 0,
                "normal process input should complete");
        } finally {
            TtsProcessCleanup.terminate(readingInput);
        }
        require(new WindowsSapiEngine().id().equals("windows-sapi"),
            "native engine ID must be stable");
        System.out.println("Platform TTS multi-voice, async queue and cancellation probe passed.");
    }

    private static void waitFor(TtsService tts, String id, String expected)
        throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            TtsService.Job job = tts.job(id);
            if (job != null && expected.equals(job.status())) return;
            if (job != null && "FAILED".equals(job.status())) {
                throw new IllegalStateException("TTS job failed: " + job.error());
            }
            Thread.sleep(15);
        }
        throw new IllegalStateException("timed out waiting for " + id);
    }

    private static void require(boolean ok, String message) {
        if (!ok) throw new IllegalStateException(message);
    }

    private static class MockEngine implements TtsService.TtsEngine {
        private final String id;
        private final String voiceName;
        final AtomicInteger calls = new AtomicInteger();

        MockEngine(String id, String voiceName) {
            this.id = id;
            this.voiceName = voiceName;
        }
        @Override public String id() { return id; }
        @Override public List<TtsService.Voice> voices() {
            return List.of(new TtsService.Voice(id + "/" + voiceName,
                id, voiceName, "ko-KR"));
        }
        @Override public byte[] synthesize(
            String voiceId, String text, int rate, int volume
        ) throws Exception {
            calls.incrementAndGet();
            return sampleWav();
        }
    }

    private static byte[] sampleWav() {
        byte[] wav = new byte[46];
        ascii(wav, 0, "RIFF");
        put32(wav, 4, wav.length - 8);
        ascii(wav, 8, "WAVE");
        ascii(wav, 12, "fmt ");
        put32(wav, 16, 16);
        put16(wav, 20, 1);
        put16(wav, 22, 1);
        put32(wav, 24, 22050);
        put32(wav, 28, 44100);
        put16(wav, 32, 2);
        put16(wav, 34, 16);
        ascii(wav, 36, "data");
        put32(wav, 40, 2);
        put16(wav, 44, 120);
        return wav;
    }

    private static void ascii(byte[] wav, int at, String value) {
        for (int i = 0; i < value.length(); i++)
            wav[at + i] = (byte) value.charAt(i);
    }
    private static void put16(byte[] wav, int at, int n) {
        wav[at] = (byte) n;
        wav[at + 1] = (byte) (n >>> 8);
    }
    private static void put32(byte[] wav, int at, int n) {
        put16(wav, at, n);
        put16(wav, at + 2, n >>> 16);
    }

    private static final class LargeWavEngine extends MockEngine {
        LargeWavEngine() { super("large-wav", "Memory test"); }
        @Override public byte[] synthesize(
            String voiceId, String text, int rate, int volume
        ) {
            if (text.startsWith("small")) return sampleWav();
            byte[] data = new byte[4 * 1024 * 1024 + 44];
            byte[] header = sampleWav();
            System.arraycopy(header, 0, data, 0, 44);
            put32(data, 4, data.length - 8);
            put32(data, 40, data.length - 44);
            return data;
        }
    }

    private static final class CorruptWavEngine extends MockEngine {
        CorruptWavEngine() { super("broken-wav", "Sample"); }
        @Override public byte[] synthesize(String voiceId, String text, int rate, int volume) {
            byte[] wav = sampleWav();
            switch (text) {
                case "missing WAVE" -> ascii(wav, 8, "NOPE");
                case "oversized chunk" -> put32(wav, 40, 100_000);
                case "bad RIFF size" -> put32(wav, 4, 0);
                case "missing fmt" -> ascii(wav, 12, "JUNK");
                case "empty audio" -> {
                    wav = java.util.Arrays.copyOf(wav, 44);
                    put32(wav, 4, wav.length - 8);
                    put32(wav, 40, 0);
                }
                case "no channels" -> put16(wav, 22, 0);
                case "no sample rate" -> put32(wav, 24, 0);
                case "no byte rate" -> put32(wav, 28, 0);
                default -> throw new IllegalStateException("unknown corruption case");
            }
            return wav;
        }
    }

    public static final class ReadProcess {
        public static void main(String[] args) throws Exception {
            byte[] bytes = System.in.readAllBytes();
            if (!"hello\\n".equals(new String(bytes,
                java.nio.charset.StandardCharsets.UTF_8))) System.exit(1);
        }
    }

    public static final class SpawnProcess {
        public static void main(String[] args) throws Exception {
            String javaExe = java.nio.file.Path.of(System.getProperty("java.home"),
                "bin", System.getProperty("os.name", "").toLowerCase().contains("win")
                    ? "java.exe" : "java").toString();
            new ProcessBuilder(javaExe, "-cp", System.getProperty("java.class.path"),
                SleepProcess.class.getName())
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .start();
            Thread.sleep(30_000);
        }
    }

    public static final class SleepProcess {
        public static void main(String[] args) throws Exception {
            Thread.sleep(30_000);
        }
    }

    private static final class BlockingEngine extends MockEngine {
        final CountDownLatch started = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);

        BlockingEngine() { super("blocked", "테스트"); }

        @Override public byte[] synthesize(
            String voiceId, String text, int rate, int volume
        ) throws Exception {
            started.countDown();
            if (!release.await(2, TimeUnit.SECONDS)) {
                throw new IllegalStateException("probe timed out");
            }
            return super.synthesize(voiceId, text, rate, volume);
        }
    }
}
