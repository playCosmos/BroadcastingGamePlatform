package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URLClassLoader;
import java.util.List;

/** No audio device or installed speech binary required. */
public final class TtsEngineExpansionProbe {
    private TtsEngineExpansionProbe() {}

    public static void main(String[] args) throws Exception {
        String sample = """
            Pty Language Age/Gender VoiceName File Other Languages
             5  en      M  default    default
             5  ko      -- Korean     asia/ko
             5  en-us   F  english-us en/en-us
             5  en-us   F  duplicate  en/en-us
            """;
        List<TtsService.Voice> voices = EspeakNgEngine.parseVoices(sample);
        require(voices.size() == 3, "unique eSpeak NG voice file IDs");
        require("espeak-ng/asia/ko".equals(voices.get(1).id()),
            "Korean voice must preserve nested file identifier");
        require("ko".equals(voices.get(1).language()),
            "language is parsed from voice list");
        require("female".equals(voices.get(2).gender()),
            "gender metadata must match the catalog schema");
        require("espeak-ng-installed".equals(voices.get(1).source()),
            "voice origin should identify optional local installation");
        require(voices.get(1).styles().contains("standard"),
            "base voice style metadata should be present");
        require(EspeakNgEngine.parseVoices(" ").isEmpty(),
            "empty voice table should be accepted");
        require(EspeakNgEngine.parseVoices("x".repeat(100_000)).isEmpty(),
            "oversized output must be rejected");
        Path temporary = Files.createTempDirectory("tts-preference-probe-");
        Path settings = temporary.resolve("voice.json");
        try {
            var saved = new TtsPreferencesStore(settings);
            require(saved.get().voiceId().isEmpty() && saved.get().volume() == 80,
                "initial defaults");
            saved.save(new TtsPreferencesStore.Preferences(
                "espeak-ng/asia/ko", -2, 75));
            require(Files.isRegularFile(settings), "preferences persisted");
            var restored = new TtsPreferencesStore(settings);
            require(restored.get().voiceId().equals("espeak-ng/asia/ko")
                && restored.get().rate() == -2
                && restored.get().volume() == 75, "restarting restores defaults");
            try (var service = new TtsService(List.of(), restored)) {
                require(service.settings().voiceId().equals("espeak-ng/asia/ko"),
                    "service reads persistent preferences");
                service.saveSettings(new TtsPreferencesStore.Preferences(
                    "", 0, 80));
                require(service.settings().voiceId().isEmpty(),
                    "automatic voice setting remains possible");
            }
            boolean rejected = false;
            try { saved.save(new TtsPreferencesStore.Preferences("no/voice", 99, 80)); }
            catch (IllegalArgumentException expected) { rejected = true; }
            require(rejected, "invalid rate must be rejected");
            Files.writeString(settings, "{invalid",
                StandardCharsets.UTF_8);
            var safeFallback = TtsPreferencesStore.loadOrDefault(settings);
            require(safeFallback.get().voiceId().isEmpty()
                && safeFallback.get().volume() == 80,
                "corrupt optional settings should not block platform startup");
            require(Files.readString(settings, StandardCharsets.UTF_8)
                .equals("{invalid"), "invalid settings preserved for inspection");
        } finally {
            Files.deleteIfExists(settings);
            Files.deleteIfExists(temporary);
        }
        // ServiceLoader must recover after a broken native adapter and
        // continue loading valid later providers in the same descriptor.
        Path spiRoot = Files.createTempDirectory("tts-spi-probe-");
        Path descriptor = spiRoot.resolve("META-INF/services/"
            + TtsService.TtsEngine.class.getName());
        ClassLoader previous = Thread.currentThread().getContextClassLoader();
        try {
            Files.createDirectories(descriptor.getParent());
            Files.writeString(descriptor,
                BrokenSpiEngine.class.getName() + "\n"
                    + HealthySpiEngine.class.getName() + "\n",
                StandardCharsets.UTF_8);
            try (var loader = new URLClassLoader(
                new java.net.URL[] { spiRoot.toUri().toURL() }, previous)) {
                Thread.currentThread().setContextClassLoader(loader);
                var discovered = TtsEngineRegistry.installed();
                require(discovered.stream().anyMatch(
                    engine -> "spi-healthy".equals(engine.id())),
                    "valid SPI providers must load after native provider failure");
            }
        } finally {
            Thread.currentThread().setContextClassLoader(previous);
            Files.deleteIfExists(descriptor);
            Files.deleteIfExists(descriptor.getParent());
            Files.deleteIfExists(descriptor.getParent().getParent());
            Files.deleteIfExists(spiRoot);
        }
        System.out.println("TTS eSpeak NG catalog and persistent preferences probe passed.");
    }

    public static final class BrokenSpiEngine implements TtsService.TtsEngine {
        public BrokenSpiEngine() {
            throw new UnsatisfiedLinkError("simulated native adapter missing");
        }
        @Override public String id() { return "spi-broken"; }
        @Override public List<TtsService.Voice> voices() { return List.of(); }
        @Override public byte[] synthesize(
            String voiceId, String text, int rate, int volume) {
            return new byte[0];
        }
    }

    public static final class HealthySpiEngine implements TtsService.TtsEngine {
        public HealthySpiEngine() {}
        @Override public String id() { return "spi-healthy"; }
        @Override public List<TtsService.Voice> voices() { return List.of(); }
        @Override public byte[] synthesize(
            String voiceId, String text, int rate, int volume) {
            return new byte[0];
        }
    }

    private static void require(boolean ok, String message) {
        if (!ok) throw new IllegalStateException(message);
    }
}
