package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import com.google.gson.Gson;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * Local administrator voice defaults. Never stores spoken text, jobs, or WAV.
 * Stored voice IDs remain stable even if a voice pack is temporarily missing.
 */
public final class TtsSettingsStore {
    public record Defaults(String voiceId, int rate, int volume) {
        public Defaults {
            if (voiceId == null) voiceId = "";
            if (voiceId.length() > 256
                || (!voiceId.isBlank() && !voiceId.matches("[^\\p{Cntrl}]{1,256}"))) {
                throw new IllegalArgumentException("invalid voice ID");
            }
            if (rate < -10 || rate > 10 || volume < 0 || volume > 100) {
                throw new IllegalArgumentException("rate or volume out of range");
            }
        }
    }

    private static final int MAX_FILE_BYTES = 4096;
    private static final Gson GSON = new Gson();
    private final Path path;
    private Defaults current;

    public TtsSettingsStore(Path path) throws IOException {
        this.path = path.toAbsolutePath().normalize();
        this.current = readFile();
    }

    public synchronized Defaults get() { return current; }

    public synchronized Defaults save(Defaults requested) throws IOException {
        if (requested == null) throw new IllegalArgumentException("settings required");
        // Reconstruct to ensure validation also applies to deserialized records.
        Defaults normalized = new Defaults(
            requested.voiceId(), requested.rate(), requested.volume());
        Path parent = path.getParent();
        if (parent != null) Files.createDirectories(parent);
        Path temp = Files.createTempFile(parent, "tts-defaults-", ".tmp");
        try {
            Files.writeString(temp, GSON.toJson(normalized) + System.lineSeparator(),
                StandardCharsets.UTF_8);
            try {
                Files.move(temp, path,
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING);
            }
            current = normalized;
        } finally {
            Files.deleteIfExists(temp);
        }
        return current;
    }

    private Defaults readFile() throws IOException {
        if (Files.notExists(path)) return new Defaults("", 0, 80);
        if (Files.size(path) > MAX_FILE_BYTES) {
            throw new IOException("TTS settings file exceeds size limit");
        }
        try {
            Defaults parsed = GSON.fromJson(
                Files.readString(path, StandardCharsets.UTF_8),
                Defaults.class);
            if (parsed == null) throw new IllegalArgumentException("empty settings");
            return new Defaults(parsed.voiceId(), parsed.rate(), parsed.volume());
        } catch (RuntimeException error) {
            throw new IOException("invalid TTS settings; manual correction required", error);
        }
    }
}
