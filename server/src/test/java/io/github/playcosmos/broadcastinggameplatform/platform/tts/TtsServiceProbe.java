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
            byte[] sample = new byte[44];
            sample[0] = 'R'; sample[1] = 'I';
            sample[2] = 'F'; sample[3] = 'F';
            return sample;
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
