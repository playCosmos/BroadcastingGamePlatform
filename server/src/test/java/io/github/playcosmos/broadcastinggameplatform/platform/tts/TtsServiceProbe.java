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
                "missing WAVE", "oversized chunk", "bad RIFF size", "missing fmt")) {
                var rejected = wavService.enqueue(new TtsService.Request(
                    malformed, voiceId, 0, 80));
                waitFor(wavService, rejected.id(), "FAILED");
                require(wavService.audio(rejected.id()) == null,
                    "corrupted WAV must never become available");
            }
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

    private static final class CorruptWavEngine extends MockEngine {
        CorruptWavEngine() { super("broken-wav", "Sample"); }
        @Override public byte[] synthesize(String voiceId, String text, int rate, int volume) {
            byte[] wav = sampleWav();
            switch (text) {
                case "missing WAVE" -> ascii(wav, 8, "NOPE");
                case "oversized chunk" -> put32(wav, 40, 100_000);
                case "bad RIFF size" -> put32(wav, 4, 0);
                case "missing fmt" -> ascii(wav, 12, "JUNK");
                default -> throw new IllegalStateException("unknown corruption case");
            }
            return wav;
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
