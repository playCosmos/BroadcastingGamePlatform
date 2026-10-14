package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.util.List;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

/**
 * Exercises installed native TTS engines, not mocked process commands.
 * Linux CI requires eSpeak NG; Windows CI runs SAPI when a desktop voice exists.
 * Never downloads models or includes synthesized audio in build artifacts.
 */
public final class TtsRealEngineSmoke {
    private TtsRealEngineSmoke() {}

    public static void main(String[] args) throws Exception {
        if (args.length < 1) throw new IllegalArgumentException(
            "expected espeak-ng, piper <model-dir>, or windows-sapi-optional");
        final TtsService.TtsEngine engine;
        final boolean required;
        switch (args[0]) {
            case "espeak-ng" -> {
                engine = new EspeakNgEngine();
                required = true;
            }
            case "piper" -> {
                if (args.length != 2) throw new IllegalArgumentException(
                    "piper requires trusted test model directory");
                engine = new PiperEngine(Path.of(args[1]));
                required = true;
            }
            case "windows-sapi-optional" -> {
                engine = new WindowsSapiEngine();
                required = false;
            }
            default -> throw new IllegalArgumentException("unknown engine smoke mode");
        }

        // A broken JSON parser or PowerShell failure is a real regression,
        // not an acceptable "no voices installed" skip.
        List<TtsService.Voice> catalog = engine.voices();
        if (catalog.isEmpty()) {
            if (required) throw new IllegalStateException(
                "expected installed " + engine.id() + " voices");
            System.out.println("TTS_ENGINE_SMOKE_SKIPPED " + engine.id()
                + " (no enabled desktop voices)");
            return;
        }
        var korean = catalog.stream().filter(v -> v.language().toLowerCase(
            java.util.Locale.ROOT).startsWith("ko")).findFirst();
        var selected = korean.orElse(catalog.getFirst());

        try (var tts = new TtsService(List.of(engine))) {
            var request = tts.enqueue(new TtsService.Request(
                korean.isPresent() ? "안녕하세요. 실제 음성 엔진 검사입니다."
                    : "Hello. This is a native speech engine validation.",
                selected.id(), 0, 80));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(50);
            TtsService.Job snapshot = null;
            while (System.nanoTime() < deadline) {
                snapshot = tts.job(request.id());
                if (snapshot == null || "FAILED".equals(snapshot.status())
                    || "CANCELLED".equals(snapshot.status())
                    || "EXPIRED".equals(snapshot.status())) {
                    throw new IllegalStateException("native synthesis failed: "
                        + (snapshot == null ? "missing job" : snapshot.error()));
                }
                if ("READY".equals(snapshot.status())) break;
                Thread.sleep(50);
            }
            if (snapshot == null || !"READY".equals(snapshot.status())) {
                throw new IllegalStateException("native speech timed out");
            }
            byte[] audio = tts.audio(request.id());
            if (audio == null || audio.length < 46) {
                throw new IllegalStateException("native engine WAV is empty");
            }
            if (audio[0] != 'R' || audio[1] != 'I' || audio[2] != 'F'
                || audio[3] != 'F' || audio[8] != 'W' || audio[9] != 'A'
                || audio[10] != 'V' || audio[11] != 'E') {
                throw new IllegalStateException("native engine WAV signature invalid");
            }
            long riffSize = (audio[4] & 255L) | ((audio[5] & 255L) << 8)
                | ((audio[6] & 255L) << 16) | ((audio[7] & 255L) << 24);
            if (riffSize + 8 != audio.length) {
                throw new IllegalStateException("native engine RIFF size invalid");
            }
            System.out.println("TTS_ENGINE_SMOKE_PASSED " + engine.id()
                + " voice=" + selected.id() + " bytes=" + audio.length);
        }
    }
}
