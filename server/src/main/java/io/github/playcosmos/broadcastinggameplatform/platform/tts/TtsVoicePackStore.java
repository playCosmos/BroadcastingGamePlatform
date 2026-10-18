package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import com.google.gson.Gson;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Stream;

/**
 * Controls metadata for operator-provided Piper ONNX/JSON pairs. No downloads,
 * uploads, arbitrary paths, executable installations or file deletion.
 * The first registration intentionally enables an opt-in managed allowlist.
 */
public final class TtsVoicePackStore {
    private static final Gson GSON = new Gson();
    private static final int SCHEMA = 1;
    private static final int MAX_PACKS = 64;
    private static final long MAX_DOCUMENT_BYTES = 64 * 1024;
    private static final long MAX_MODEL_BYTES = 1024L * 1024 * 1024;
    private static final long MAX_CONFIG_BYTES = 256 * 1024;

    public record Pack(String model, String version, String license,
                       String sha256, String configSha256, boolean enabled) {
        public Pack {
            checkModelName(model);
            if (version == null || !version.matches("[A-Za-z0-9][A-Za-z0-9_.+-]{0,47}")
                || license == null || !license.matches("[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}")
                || !hashSyntax(sha256) || !hashSyntax(configSha256)) {
                throw new IllegalArgumentException("invalid model metadata or digest");
            }
            sha256 = sha256.toLowerCase(java.util.Locale.ROOT);
            configSha256 = configSha256.toLowerCase(java.util.Locale.ROOT);
        }
    }
    public record Registration(String model, String version, String license,
                               String sha256, boolean licenseAcknowledged) {}
    public record Candidate(String model, long modelBytes, boolean configPresent,
                            String state, String version, String license,
                            String sha256, boolean enabled) {}
    public record Inventory(String mode, List<Candidate> packs) {}
    public record Verification(String model, boolean match, String modelSha256,
                               String configSha256) {}
    private record Document(int schema, List<Pack> packs) {}

    private final Path directory;
    private final Path manifest;
    private final LinkedHashMap<String, Pack> packs = new LinkedHashMap<>();
    // INVALID is fail-closed. In particular, corruption cannot re-enable models.
    private String mode = "LEGACY";

    public TtsVoicePackStore(Path applicationRoot) {
        Objects.requireNonNull(applicationRoot, "applicationRoot");
        Path root = applicationRoot.toAbsolutePath().normalize();
        directory = root.resolve("tts/voices");
        manifest = root.resolve("tts/voice-packs.json");
        if (!Files.exists(manifest, LinkOption.NOFOLLOW_LINKS)) return;
        mode = "INVALID";
        try {
            if (Files.isSymbolicLink(manifest)
                || !Files.isRegularFile(manifest, LinkOption.NOFOLLOW_LINKS)
                || Files.size(manifest) > MAX_DOCUMENT_BYTES) {
                throw new IOException("invalid voice pack manifest");
            }
            Document doc = GSON.fromJson(
                Files.readString(manifest, StandardCharsets.UTF_8), Document.class);
            if (doc == null || doc.schema() != SCHEMA || doc.packs() == null
                || doc.packs().size() > MAX_PACKS) {
                throw new IOException("invalid voice pack manifest schema");
            }
            for (Pack raw : doc.packs()) {
                if (raw == null) throw new IOException("null voice pack entry");
                Pack checked = new Pack(raw.model(), raw.version(), raw.license(),
                    raw.sha256(), raw.configSha256(), raw.enabled());
                if (packs.putIfAbsent(checked.model(), checked) != null) {
                    throw new IOException("duplicate voice model");
                }
            }
            mode = "MANAGED";
        } catch (IOException | RuntimeException invalid) {
            packs.clear();
            System.err.println("[tts] voice pack registry invalid; "
                + "all managed Piper voices disabled until manual repair");
        }
    }

    public synchronized String mode() { return mode; }

    /** On inventory reads, avoid hashing potentially gigabytes of model data. */
    public synchronized Inventory inventory() throws IOException {
        var result = new ArrayList<Candidate>();
        var found = new java.util.HashSet<String>();
        if (Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)
            && !Files.isSymbolicLink(directory)) {
            try (Stream<Path> files = Files.list(directory)) {
                for (Path file : files.sorted(Comparator.comparing(Path::toString))
                    .limit(MAX_PACKS + 1L).toList()) {
                    String name = file.getFileName().toString();
                    if (!name.endsWith(".onnx")) continue;
                    String stem = name.substring(0, name.length() - 5);
                    if (!validModelName(stem) || Files.isSymbolicLink(file)
                        || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) continue;
                    found.add(stem);
                    Pack registered = packs.get(stem);
                    boolean ready = safePair(stem);
                    String state = "INVALID".equals(mode) ? "REGISTRY_INVALID"
                        : !ready ? "INCOMPLETE"
                        : "LEGACY".equals(mode) ? "UNMANAGED"
                        : registered == null ? "UNREGISTERED"
                        : registered.enabled() ? "REGISTERED" : "DISABLED";
                    result.add(new Candidate(stem, Files.size(file),
                        ready, state,
                        registered == null ? "" : registered.version(),
                        registered == null ? "" : registered.license(),
                        registered == null ? "" : registered.sha256(),
                        registered != null && registered.enabled()));
                }
            }
        }
        for (Pack registered : packs.values()) {
            if (!found.contains(registered.model())) {
                result.add(new Candidate(registered.model(), 0L, false,
                    "MISSING", registered.version(), registered.license(),
                    registered.sha256(), registered.enabled()));
            }
        }
        return new Inventory(mode, List.copyOf(result));
    }

    public synchronized Inventory register(Registration request) throws IOException {
        requireHealthy();
        if (request == null || !request.licenseAcknowledged()) {
            throw new IllegalArgumentException("operator license acknowledgement required");
        }
        checkModelName(request.model());
        if (!hashSyntax(request.sha256())) {
            throw new IllegalArgumentException("expected SHA-256 must have 64 hex digits");
        }
        // Treat the supplied model digest as a trusted external value: never
        // silently fill it from the local file.
        var actual = digests(request.model());
        if (!actual.modelSha256().equalsIgnoreCase(request.sha256())) {
            throw new IllegalArgumentException("model SHA-256 mismatch");
        }
        Pack pack = new Pack(request.model(), request.version(), request.license(),
            request.sha256(), actual.configSha256(), true);
        var updated = new LinkedHashMap<>(packs);
        if (!updated.containsKey(pack.model()) && updated.size() >= MAX_PACKS) {
            throw new IllegalArgumentException("voice pack limit reached");
        }
        updated.put(pack.model(), pack);
        persist(updated);
        replace(updated);
        return inventory();
    }

    public synchronized Inventory setEnabled(String model, boolean enabled)
        throws IOException {
        requireHealthy();
        Pack current = packs.get(model);
        if (current == null) throw new IllegalArgumentException("pack not registered");
        if (enabled && !matches(current)) {
            throw new IllegalArgumentException("voice pack checksum mismatch or files missing");
        }
        var updated = new LinkedHashMap<>(packs);
        updated.put(model, new Pack(model, current.version(), current.license(),
            current.sha256(), current.configSha256(), enabled));
        persist(updated);
        replace(updated);
        return inventory();
    }

    /** Removes only the registration; ONNX and JSON files remain untouched. */
    public synchronized Inventory unregister(String model) throws IOException {
        requireHealthy();
        if (!packs.containsKey(model)) {
            throw new IllegalArgumentException("pack not registered");
        }
        var updated = new LinkedHashMap<>(packs);
        updated.remove(model);
        persist(updated); // Retains MANAGED mode even when empty.
        replace(updated);
        return inventory();
    }

    public synchronized Verification verify(String model) throws IOException {
        checkModelName(model);
        var hashes = digests(model);
        Pack registered = packs.get(model);
        return new Verification(model, registered != null
            && registered.sha256().equals(hashes.modelSha256())
            && registered.configSha256().equals(hashes.configSha256()),
            hashes.modelSha256(), hashes.configSha256());
    }

    /** Called at catalog discovery and immediately before Piper synthesis. */
    public synchronized boolean allowed(String model) {
        if ("INVALID".equals(mode)) return false;
        if (!safePair(model)) return false;
        if ("LEGACY".equals(mode)) return true;
        Pack registered = packs.get(model);
        if (registered == null || !registered.enabled()) return false;
        try { return matches(registered); }
        catch (IOException invalid) { return false; }
    }

    private boolean matches(Pack pack) throws IOException {
        try {
            var hashes = digests(pack.model());
            return pack.sha256().equals(hashes.modelSha256())
                && pack.configSha256().equals(hashes.configSha256());
        } catch (IllegalArgumentException missing) {
            return false;
        }
    }

    private Verification digests(String model) throws IOException {
        if (!safePair(model)) {
            throw new IllegalArgumentException("Piper model/config pair unavailable or unsafe");
        }
        Path onnx = directory.resolve(model + ".onnx");
        Path json = directory.resolve(model + ".onnx.json");
        // JSON parsing is a structural check, not a voice license audit.
        try {
            JsonParser.parseString(Files.readString(json, StandardCharsets.UTF_8))
                .getAsJsonObject();
        } catch (RuntimeException invalid) {
            throw new IllegalArgumentException("invalid Piper JSON config");
        }
        return new Verification(model, false,
            sha256(onnx, MAX_MODEL_BYTES), sha256(json, MAX_CONFIG_BYTES));
    }

    private static String sha256(Path file, long maxBytes) throws IOException {
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException unavailable) {
            throw new IllegalStateException(unavailable);
        }
        long read = 0;
        try (InputStream in = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                read += n;
                if (read > maxBytes) throw new IOException("voice pack exceeds size limit");
                digest.update(buf, 0, n);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private boolean safePair(String model) {
        if (!validModelName(model) || Files.isSymbolicLink(directory)
            || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) return false;
        Path onnx = directory.resolve(model + ".onnx");
        Path json = directory.resolve(model + ".onnx.json");
        try {
            return !Files.isSymbolicLink(onnx) && !Files.isSymbolicLink(json)
                && Files.isRegularFile(onnx, LinkOption.NOFOLLOW_LINKS)
                && Files.isRegularFile(json, LinkOption.NOFOLLOW_LINKS)
                && Files.size(onnx) > 0 && Files.size(onnx) <= MAX_MODEL_BYTES
                && Files.size(json) > 0 && Files.size(json) <= MAX_CONFIG_BYTES;
        } catch (IOException invalid) { return false; }
    }

    private void persist(Map<String, Pack> updated) throws IOException {
        if (Files.isSymbolicLink(manifest) || Files.isSymbolicLink(manifest.getParent())) {
            throw new IOException("unsafe voice pack registry path");
        }
        String json = GSON.toJson(new Document(SCHEMA,
            List.copyOf(updated.values()))) + System.lineSeparator();
        if (json.getBytes(StandardCharsets.UTF_8).length > MAX_DOCUMENT_BYTES) {
            throw new IllegalArgumentException("voice pack registry too large");
        }
        Files.createDirectories(manifest.getParent());
        Path tmp = Files.createTempFile(manifest.getParent(), ".tts-packs-", ".tmp");
        try {
            Files.writeString(tmp, json, StandardCharsets.UTF_8);
            try {
                Files.move(tmp, manifest, StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(tmp, manifest, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    private void replace(Map<String, Pack> updated) {
        packs.clear();
        packs.putAll(updated);
        mode = "MANAGED";
    }

    private void requireHealthy() {
        if ("INVALID".equals(mode)) {
            throw new IllegalStateException("invalid voice pack registry: manual repair required");
        }
    }

    private static boolean hashSyntax(String hash) {
        return hash != null && hash.matches("[0-9a-fA-F]{64}");
    }
    private static boolean validModelName(String name) {
        return name != null && name.matches("[A-Za-z0-9][A-Za-z0-9_.+-]{0,95}");
    }
    private static void checkModelName(String name) {
        if (!validModelName(name)) {
            throw new IllegalArgumentException("invalid Piper model filename");
        }
    }
}
