package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import com.google.gson.Gson;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/** Atomic, narrowly-scoped global TTS defaults; no speech text or WAV data. */
public final class TtsPreferencesStore {
    private static final Gson GSON = new Gson();

    public record Preferences(String voiceId, int rate, int volume) {
        public Preferences {
            if (voiceId == null) throw new IllegalArgumentException("voiceId is required");
            if (voiceId.length() > 200 || voiceId.chars().anyMatch(ch ->
                ch < 32 || ch == 127)) {
                throw new IllegalArgumentException("voiceId is invalid");
            }
            // An empty voiceId means follow the first installed Korean voice.
            if (!voiceId.isEmpty()
                && (!voiceId.contains("/") || voiceId.startsWith("/")
                    || voiceId.endsWith("/"))) {
                throw new IllegalArgumentException("voiceId must name an engine");
            }
            if (rate < -10 || rate > 10 || volume < 0 || volume > 100) {
                throw new IllegalArgumentException("rate or volume out of range");
            }
        }
    }

    private static final Preferences DEFAULTS = new Preferences("", 0, 80);
    private final Path path;
    private Preferences current;

    public TtsPreferencesStore(Path path) throws IOException {
        this(path, false);
    }

    /**
     * Platform startup must continue even if optional TTS settings are corrupt.
     * Preserve the file until an administrator explicitly saves new settings.
     */
    public static TtsPreferencesStore loadOrDefault(Path path) {
        try {
            return new TtsPreferencesStore(path);
        } catch (IOException error) {
            System.err.println("[tts] persisted voice settings unavailable; "
                + "using defaults until an administrator saves them");
            try {
                return new TtsPreferencesStore(path, true);
            } catch (IOException impossible) {
                throw new IllegalStateException(impossible);
            }
        }
    }

    private TtsPreferencesStore(Path path, boolean skipExisting) throws IOException {
        this.path = path == null ? null : path.toAbsolutePath().normalize();
        current = DEFAULTS;
        if (!skipExisting && this.path != null && Files.exists(this.path)) {
            try {
                if (Files.size(this.path) > 8192) {
                    throw new IOException("TTS settings file is too large");
                }
                var parsed = GSON.fromJson(
                    Files.readString(this.path, StandardCharsets.UTF_8),
                    Preferences.class
                );
                if (parsed == null) throw new IOException("TTS settings file is empty");
                current = new Preferences(parsed.voiceId(), parsed.rate(), parsed.volume());
            } catch (IOException | RuntimeException error) {
                // A corrupted optional TTS preference must not prevent the
                // games/platform server from starting. Keep the file intact
                // for operator inspection and use safe in-memory defaults.
                current = DEFAULTS;
                System.err.println("[tts] preferences could not be loaded: "
                    + error.getClass().getSimpleName()
                    + " (using defaults; original file preserved)");
            }
        }
    }

    public synchronized Preferences get() { return current; }

    public synchronized Preferences save(Preferences preferences) throws IOException {
        if (preferences == null) {
            throw new IllegalArgumentException("TTS preferences required");
        }
        var next = new Preferences(preferences.voiceId(),
            preferences.rate(), preferences.volume());
        if (path != null) {
            Path parent = path.getParent();
            if (parent != null) Files.createDirectories(parent);
            Path temporary = Files.createTempFile(parent, ".tts-settings-", ".tmp");
            try {
                Files.writeString(temporary,
                    GSON.toJson(next) + System.lineSeparator(),
                    StandardCharsets.UTF_8);
                try {
                    Files.move(temporary, path,
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
                } catch (AtomicMoveNotSupportedException ignored) {
                    Files.move(temporary, path,
                        StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(temporary);
            }
        }
        current = next;
        return current;
    }
}
