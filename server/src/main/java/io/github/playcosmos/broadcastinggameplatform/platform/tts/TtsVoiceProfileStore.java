package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import com.google.gson.Gson;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Objects;

/**
 * Administrator-managed, named speech presets. No samples, speech text,
 * generated audio, engine binaries or models are persisted.
 */
public final class TtsVoiceProfileStore {
    private static final Gson GSON = new Gson();
    private static final int MAX_PROFILES = 24;
    private static final long MAX_FILE_BYTES = 16 * 1024;
    private static final int SCHEMA_VERSION = 1;

    public record Profile(String name, String voiceId, int rate, int volume) {
        public Profile {
            if (name == null || name.isBlank()
                || name.codePointCount(0, name.length()) > 40
                || !name.equals(name.strip())
                || name.codePoints().anyMatch(ch -> Character.isISOControl(ch))) {
                throw new IllegalArgumentException("profile name is invalid");
            }
            new TtsPreferencesStore.Preferences(voiceId, rate, volume);
            if (voiceId.isEmpty()) {
                throw new IllegalArgumentException("profile requires a voice");
            }
        }
    }

    private record Document(int version, List<Profile> profiles) {}

    private final Path path;
    private final LinkedHashMap<String, Profile> profiles = new LinkedHashMap<>();

    /** A null path keeps profiles in memory (useful for isolated tests). */
    public TtsVoiceProfileStore(Path path) {
        this.path = path == null ? null : path.toAbsolutePath().normalize();
        if (this.path == null || !Files.exists(this.path)) return;
        try {
            if (!Files.isRegularFile(this.path)
                || Files.size(this.path) > MAX_FILE_BYTES) {
                throw new IOException("TTS profile file is unavailable or too large");
            }
            Document saved = GSON.fromJson(
                Files.readString(this.path, StandardCharsets.UTF_8), Document.class);
            if (saved == null || saved.version() != SCHEMA_VERSION
                || saved.profiles() == null
                || saved.profiles().size() > MAX_PROFILES) {
                throw new IOException("invalid TTS profile document");
            }
            for (Profile value : saved.profiles()) {
                if (value == null) throw new IOException("null TTS profile");
                Profile checked = checked(value);
                if (profiles.putIfAbsent(checked.name(), checked) != null) {
                    throw new IOException("duplicate TTS profile name");
                }
            }
        } catch (IOException | RuntimeException error) {
            profiles.clear();
            System.err.println("[tts] profiles could not be loaded: "
                + error.getClass().getSimpleName()
                + " (using empty collection; original file preserved)");
        }
    }

    public synchronized List<Profile> list() {
        return List.copyOf(profiles.values());
    }

    /** Upsert by exact name, preserving stable order and the 24-entry cap. */
    public synchronized List<Profile> save(Profile profile) throws IOException {
        Objects.requireNonNull(profile, "profile");
        Profile checked = checked(profile);
        var updated = new LinkedHashMap<>(profiles);
        if (!updated.containsKey(checked.name()) && updated.size() >= MAX_PROFILES) {
            throw new IllegalArgumentException("profile limit reached (24)");
        }
        updated.put(checked.name(), checked);
        persist(updated);
        profiles.clear();
        profiles.putAll(updated);
        return list();
    }

    public synchronized boolean delete(String name) throws IOException {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("profile name is required");
        }
        if (!profiles.containsKey(name)) return false;
        var updated = new LinkedHashMap<>(profiles);
        updated.remove(name);
        persist(updated);
        profiles.clear();
        profiles.putAll(updated);
        return true;
    }

    private static Profile checked(Profile profile) {
        return new Profile(profile.name(), profile.voiceId(),
            profile.rate(), profile.volume());
    }

    private void persist(LinkedHashMap<String, Profile> updated) throws IOException {
        if (path == null) return;
        String json = GSON.toJson(new Document(
            SCHEMA_VERSION, List.copyOf(updated.values()))) + System.lineSeparator();
        if (json.getBytes(StandardCharsets.UTF_8).length > MAX_FILE_BYTES) {
            throw new IllegalArgumentException("profile document too large");
        }
        Path parent = path.getParent();
        if (parent != null) Files.createDirectories(parent);
        Path temporary = Files.createTempFile(parent, ".tts-profiles-", ".tmp");
        try {
            Files.writeString(temporary, json, StandardCharsets.UTF_8);
            try {
                Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }
}
