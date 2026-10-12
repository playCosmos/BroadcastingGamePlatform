package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * Optional Windows desktop SpeechSynthesizer backend.
 * No bundled models or external dependencies. Installed system voices vary
 * by machine; this backend does not install or download voices.
 */
public final class WindowsSapiEngine implements TtsService.TtsEngine {
    private static final int PROCESS_TIMEOUT_SECONDS = 30;
    private static final int MAX_STDOUT_BYTES = 32_768;
    private final boolean supported = System.getProperty("os.name", "")
        .toLowerCase(Locale.ROOT).contains("windows");
    private volatile List<TtsService.Voice> cachedVoices = List.of();
    private volatile long cachedAt;

    @Override public String id() { return "windows-sapi"; }

    @Override public synchronized void invalidateVoiceCatalog() {
        cachedAt = 0;
    }

    @Override
    public synchronized List<TtsService.Voice> voices() throws Exception {
        if (!supported) return List.of();
        long now = System.nanoTime();
        if (cachedAt != 0 && now - cachedAt < Duration.ofMinutes(2).toNanos()) {
            return cachedVoices;
        }
        String script = """
            $ErrorActionPreference='Stop'
            [Console]::OutputEncoding = [Text.Encoding]::UTF8
            Add-Type -AssemblyName System.Speech
            $speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
            try {
              $installed = @($speech.GetInstalledVoices() |
                Where-Object { $_.Enabled } |
                ForEach-Object {
                  [pscustomobject]@{
                    name = $_.VoiceInfo.Name
                    language = $_.VoiceInfo.Culture.Name
                  }
                })
              [Console]::Out.Write((ConvertTo-Json -InputObject $installed -Compress -Depth 3))
            } finally { $speech.Dispose() }
            """;
        byte[] output = runPowerShell(script);
        var parsed = JsonParser.parseString(new String(output, StandardCharsets.UTF_8));
        var discovered = new ArrayList<TtsService.Voice>();
        if (!parsed.isJsonArray()) throw new IllegalStateException("invalid voice catalog");
        for (var item : parsed.getAsJsonArray()) {
            if (!item.isJsonObject()) continue;
            var object = item.getAsJsonObject();
            if (!object.has("name") || !object.has("language")) continue;
            String name = object.get("name").getAsString();
            String language = object.get("language").getAsString();
            if (name.isBlank() || name.contains("/") || name.length() > 120) {
                continue;
            }
            discovered.add(new TtsService.Voice(
                id() + "/" + name, id(), name, language
            ));
        }
        cachedVoices = List.copyOf(discovered);
        cachedAt = now;
        return cachedVoices;
    }

    @Override
    public byte[] synthesize(String voiceId, String text, int rate, int volume)
        throws Exception {
        if (!supported) throw new IllegalStateException("Windows required");
        String prefix = id() + "/";
        if (voiceId == null || !voiceId.startsWith(prefix)
            || voices().stream().noneMatch(v -> v.id().equals(voiceId))) {
            throw new IllegalArgumentException("voice not installed");
        }
        Path wave = Files.createTempFile("bgp-tts-", ".wav");
        try {
            String script = """
                $ErrorActionPreference='Stop'
                [Console]::OutputEncoding = [Text.Encoding]::UTF8
                Add-Type -AssemblyName System.Speech
                $speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
                try {
                  $voice = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__VOICE__'))
                  $spoken = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__TEXT__'))
                  $file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__FILE__'))
                  $speech.SelectVoice($voice)
                  $speech.Rate = __RATE__
                  $speech.Volume = __VOLUME__
                  $speech.SetOutputToWaveFile($file)
                  $speech.Speak($spoken)
                  $speech.SetOutputToNull()
                } finally { $speech.Dispose() }
                """
                .replace("__VOICE__", base64(voiceId.substring(prefix.length())))
                .replace("__TEXT__", base64(text))
                .replace("__FILE__", base64(wave.toAbsolutePath().toString()))
                .replace("__RATE__", Integer.toString(rate))
                .replace("__VOLUME__", Integer.toString(volume));
            runPowerShell(script);
            if (Files.size(wave) > 5 * 1024 * 1024) {
                throw new IllegalStateException("WAV is too large");
            }
            return Files.readAllBytes(wave);
        } finally {
            Files.deleteIfExists(wave);
        }
    }

    private static String base64(String text) {
        return Base64.getEncoder().encodeToString(
            text.getBytes(StandardCharsets.UTF_8)
        );
    }

    static byte[] runPowerShell(String script) throws Exception {
        String encoded = Base64.getEncoder().encodeToString(
            script.getBytes(StandardCharsets.UTF_16LE)
        );
        Path captured = Files.createTempFile("bgp-tts-output-", ".log");
        Process process = null;
        try {
            process = new ProcessBuilder(
                "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
                "-EncodedCommand", encoded
            ).redirectErrorStream(true)
                .redirectOutput(captured.toFile())
                .start();
            if (!process.waitFor(PROCESS_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
                throw new IllegalStateException("Windows speech timed out");
            }
            long length = Files.size(captured);
            if (length > MAX_STDOUT_BYTES) {
                throw new IllegalStateException("Windows speech output too large");
            }
            byte[] output = Files.readAllBytes(captured);
            if (process.exitValue() != 0) {
                // Do not expose raw PowerShell errors to the public API.
                throw new IllegalStateException("Windows speech backend unavailable");
            }
            return output;
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
            Files.deleteIfExists(captured);
        }
    }
}
