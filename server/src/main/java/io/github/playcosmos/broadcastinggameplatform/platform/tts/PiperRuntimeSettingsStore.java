package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import com.google.gson.Gson;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Objects;

/** Operator-only, local Piper worker policy. Never stores executable paths. */
public final class PiperRuntimeSettingsStore {
    private static final Gson GSON = new Gson();
    private static final int MAX_BYTES = 1024;
    private static final int SCHEMA = 1;
    public record Settings(boolean enabled, int idleSeconds) {
        public Settings {
            if (idleSeconds < 10 || idleSeconds > 600) {
                throw new IllegalArgumentException("Piper idle seconds must be 10–600");
            }
        }
    }
    private record Document(int schema, boolean enabled, int idleSeconds) {}

    private final Path file;
    private final boolean defaultEnabled;
    private Settings current;
    private boolean invalid;

    public PiperRuntimeSettingsStore(Path applicationRoot, boolean defaultEnabled) {
        Objects.requireNonNull(applicationRoot, "applicationRoot");
        this.file = applicationRoot.toAbsolutePath().normalize()
            .resolve("tts/piper-runtime.json");
        this.defaultEnabled = defaultEnabled;
        current = new Settings(defaultEnabled, 60);
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return;
        try {
            if (Files.isSymbolicLink(file) || Files.isSymbolicLink(file.getParent())
                || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
                || Files.size(file) > MAX_BYTES) {
                throw new IOException("unsafe Piper runtime policy");
            }
            Document found = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8),
                Document.class);
            if (found == null || found.schema() != SCHEMA) {
                throw new IOException("invalid Piper runtime policy version");
            }
            current = new Settings(found.enabled(), found.idleSeconds());
        } catch (IOException | RuntimeException malformed) {
            invalid = true;
            current = new Settings(false, 60);
            System.err.println("[tts] invalid Piper runtime settings: "
                + "resident worker disabled until manual repair");
        }
    }

    public synchronized Settings get() { return current; }
    public synchronized boolean invalid() { return invalid; }
    public synchronized Settings save(Settings next) throws IOException {
        if (invalid) throw new IllegalStateException(
            "invalid Piper runtime settings require manual repair");
        Objects.requireNonNull(next, "settings");
        var validated = new Settings(next.enabled(), next.idleSeconds());
        if (validated.enabled() && !defaultEnabled) {
            throw new IllegalArgumentException(
                "Piper Python environment must be configured on the host");
        }
        if (Files.isSymbolicLink(file.getParent())
            || Files.isSymbolicLink(file)) {
            throw new IOException("unsafe Piper runtime settings path");
        }
        Files.createDirectories(file.getParent());
        String encoded = GSON.toJson(new Document(SCHEMA,
            validated.enabled(), validated.idleSeconds())) + "\n";
        if (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES)
            throw new IOException("Piper runtime settings too large");
        Path temp = Files.createTempFile(file.getParent(), ".piper-runtime-", ".tmp");
        try {
            Files.writeString(temp, encoded, StandardCharsets.UTF_8);
            try {
                Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temp);
        }
        current = validated;
        return current;
    }
}
