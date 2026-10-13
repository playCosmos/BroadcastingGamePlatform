package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * Optional local eSpeak NG adapter. Available only if espeak-ng is already
 * installed on PATH. Nothing is downloaded, installed, or bundled.
 */
public final class EspeakNgEngine implements TtsService.TtsEngine {
    private static final int VOICE_LIST_LIMIT = 64 * 1024;
    private static final int WAV_LIMIT = 5 * 1024 * 1024;
    private volatile List<TtsService.Voice> cached = List.of();
    private volatile long lastLookupNanos;

    @Override public String id() { return "espeak-ng"; }

    @Override public synchronized void invalidateVoiceCatalog() {
        lastLookupNanos = 0;
    }

    @Override
    public synchronized List<TtsService.Voice> voices() throws Exception {
        long now = System.nanoTime();
        if (lastLookupNanos != 0
            && now - lastLookupNanos < Duration.ofMinutes(2).toNanos()) {
            return cached;
        }
        Path output = Files.createTempFile("bgp-espeak-voices-", ".txt");
        try {
            boolean installed = execute(List.of("espeak-ng", "--voices"),
                output, 4);
            cached = installed && Files.size(output) <= VOICE_LIST_LIMIT
                ? parseVoices(Files.readString(output, StandardCharsets.UTF_8))
                : List.of();
            lastLookupNanos = now;
            return cached;
        } finally {
            Files.deleteIfExists(output);
        }
    }

    /** Public for isolated parser regression tests. */
    public static List<TtsService.Voice> parseVoices(String output) {
        if (output == null || output.length() > VOICE_LIST_LIMIT) {
            return List.of();
        }
        var result = new LinkedHashMap<String, TtsService.Voice>();
        for (String line : output.split("\\R")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("Pty ")) continue;
            String[] parts = trimmed.split("\\s+");
            if (parts.length < 5) continue;
            String language = parts[1];
            String gender = parts[2];
            String name = parts[3].replace('_', ' ');
            String identifier = parts[4];
            if (!identifier.matches("[A-Za-z0-9_+./-]{1,100}")
                || !language.matches("[A-Za-z0-9_-]{2,24}")) continue;
            // eSpeak voice-file identifier, not a mutable display name.
            result.putIfAbsent(identifier, new TtsService.Voice(
                "espeak-ng/" + identifier, "espeak-ng", name,
                language.replace('_', '-'),
                "F".equalsIgnoreCase(gender) ? "female"
                    : "M".equalsIgnoreCase(gender) ? "male" : "unknown",
                List.of("standard"), "espeak-ng-installed"
            ));
        }
        return List.copyOf(result.values());
    }

    @Override
    public byte[] synthesize(String voiceId, String text, int rate, int volume)
        throws Exception {
        String prefix = id() + "/";
        if (voiceId == null || !voiceId.startsWith(prefix)
            || voices().stream().noneMatch(v -> v.id().equals(voiceId))) {
            throw new IllegalArgumentException("eSpeak NG voice unavailable");
        }
        String selected = voiceId.substring(prefix.length());
        Path input = Files.createTempFile("bgp-espeak-text-", ".txt");
        Path output = null;
        try {
            output = Files.createTempFile("bgp-espeak-audio-", ".wav");
            Files.writeString(input, text, StandardCharsets.UTF_8);
            int wordsPerMinute = Math.max(80, Math.min(300, 175 + rate * 10));
            boolean ok = execute(List.of("espeak-ng",
                "-v", selected, "-s", String.valueOf(wordsPerMinute),
                "-a", String.valueOf(volume), "--stdout",
                "-f", input.toString()), output, 30);
            if (!ok || Files.size(output) > WAV_LIMIT) {
                throw new IllegalStateException("eSpeak NG synthesis failed");
            }
            return Files.readAllBytes(output);
        } finally {
            Files.deleteIfExists(input);
            if (output != null) Files.deleteIfExists(output);
        }
    }

    private static boolean execute(List<String> arguments, Path output,
        int timeoutSeconds) throws Exception {
        Process process;
        try {
            process = new ProcessBuilder(arguments)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .redirectOutput(output.toFile()).start();
        } catch (IOException missingExecutable) {
            return false;
        }
        try {
            if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                TtsProcessCleanup.terminate(process);
                return false;
            }
            return process.exitValue() == 0;
        } finally {
            TtsProcessCleanup.terminate(process);
        }
    }
}
