package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Optional Piper model-resident subprocess, not a web server or plugin.
 * Exactly one trusted model and one request at a time; stdio carries
 * length-prefixed WAV responses. Only an operator-supplied Python environment
 * with Piper installed can opt in. Every request re-hashes ONNX and config;
 * neither input speech nor output audio persists beyond the existing TTS job.
 */
final class PiperWarmWorker implements AutoCloseable {
    static final int MAX_WAV_BYTES = 5 * 1024 * 1024;
    static final long IDLE_NANOS = TimeUnit.SECONDS.toNanos(60);
    private static final long MAX_MODEL_BYTES = 1024L * 1024 * 1024;
    private static final long MAX_CONFIG_BYTES = 256 * 1024;
    private static final long REQUEST_NANOS = TimeUnit.SECONDS.toNanos(30);

    // Shipped as a fixed -c script, not loaded from an administrator-controlled
    // path. Child stdin = one JSON request per line; stdout = READY byte, then
    // 4-byte big-endian WAV length + exact WAV bytes for each response.
    // No HTTP listener, dynamic imports of application code or network calls.
    private static final String SCRIPT = """
        import io, json, struct, sys, wave
        from piper import PiperVoice, SynthesisConfig

        voice = PiperVoice.load(sys.argv[1], config_path=sys.argv[2])
        sys.stdout.buffer.write(b'R')
        sys.stdout.buffer.flush()
        for line in sys.stdin:
            try:
                req = json.loads(line)
                text = req["text"]
                length_scale = float(req["length_scale"])
                speaker_id = req.get("speaker_id")
                if not isinstance(text, str) or not text or len(text) > 2000:
                    raise ValueError("invalid text")
                if not (0.65 <= length_scale <= 1.8):
                    raise ValueError("invalid length scale")
                if speaker_id is not None and (type(speaker_id) is not int or
                    not (0 <= speaker_id <= 255)):
                    raise ValueError("invalid speaker")
                out = io.BytesIO()
                with wave.open(out, "wb") as wav:
                    voice.synthesize_wav(
                        text, wav,
                        syn_config=SynthesisConfig(
                            speaker_id=speaker_id, length_scale=length_scale))
                data = out.getvalue()
                if not (44 <= len(data) <= 5 * 1024 * 1024):
                    raise ValueError("invalid WAV size")
                sys.stdout.buffer.write(struct.pack(">I", len(data)))
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            except Exception:
                # No speech text, filenames or exception detail on stdout.
                sys.exit(1)
        """;

    private final Path python;
    private final long idleNanos;
    private final Thread reaper;
    private volatile Process process;
    private Path model;
    private Path config;
    private String fingerprint;
    private long lastUsedNanos;
    private volatile boolean closed;

    PiperWarmWorker(Path python) {
        this(python, IDLE_NANOS);
    }

    // Inject a short timeout in lifecycle tests, without shortening production.
    PiperWarmWorker(Path python, long idleNanos) {
        Objects.requireNonNull(python, "python");
        if (!python.isAbsolute() || !Files.isRegularFile(python)
            || idleNanos <= 0) {
            throw new IllegalArgumentException("trusted absolute Piper Python required");
        }
        this.python = python.toAbsolutePath().normalize();
        this.idleNanos = idleNanos;
        this.reaper = Thread.ofVirtual().name("tts-piper-idle-reaper")
            .start(this::reapIdle);
    }

    static Path configuredPython() {
        String value = System.getenv("BGP_TTS_PIPER_WARM_PYTHON");
        if (value == null || value.isBlank()) return null;
        Path path = Path.of(value);
        if (!path.isAbsolute() || !Files.isRegularFile(path)) {
            System.err.println("[tts] Piper warm mode disabled: Python executable not found");
            return null;
        }
        return path.toAbsolutePath().normalize();
    }

    /** Synchronized across all calls: never interleave request/response frames. */
    synchronized byte[] synthesize(Path requestedModel, Path requestedConfig,
                                    String text, Integer speaker, double lengthScale)
        throws Exception {
        if (closed) throw new IllegalStateException("Piper worker closed");
        // Revalidate the exact local files even in legacy pack mode. Managed
        // pack license/enablement and externally trusted hashes are checked
        // independently by PiperEngine *before* entering this method.
        String nextFingerprint = fingerprint(requestedModel, requestedConfig);
        if (process != null && (!process.isAlive()
            || !requestedModel.equals(model) || !requestedConfig.equals(config)
            || !nextFingerprint.equals(fingerprint))) {
            terminate();
        }
        long deadline = System.nanoTime() + REQUEST_NANOS;
        if (process == null) {
            process = new ProcessBuilder(
                python.toString(), "-I", "-u", "-c", SCRIPT,
                requestedModel.toString(), requestedConfig.toString())
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
            model = requestedModel;
            config = requestedConfig;
            fingerprint = nextFingerprint;
            try {
                int ready = boundedIO(() -> process.getInputStream().read(), deadline);
                if (ready != 'R') throw new IOException("Piper worker startup failed");
            } catch (Exception failed) {
                terminate();
                throw failed;
            }
        }
        // Fixed field order and JSON escaping via Gson rather than interpolating
        // user text into a shell or an executable script.
        var request = new com.google.gson.JsonObject();
        request.addProperty("text", text);
        request.addProperty("length_scale", lengthScale);
        if (speaker != null) request.addProperty("speaker_id", speaker);
        byte[] command = (request.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        if (command.length > 8 * 1024)
            throw new IllegalArgumentException("Piper command exceeds size limit");
        try {
            boundedIO(() -> {
                process.getOutputStream().write(command);
                process.getOutputStream().flush();
                return null;
            }, deadline);
            byte[] response = boundedIO(() -> {
                var input = new DataInputStream(process.getInputStream());
                int length = input.readInt();
                if (length < 44 || length > MAX_WAV_BYTES)
                    throw new IOException("Piper frame exceeds WAV limit");
                return input.readNBytes(length);
            }, deadline);
            if (response.length < 44 || response.length > MAX_WAV_BYTES) {
                throw new IOException("Piper WAV truncated");
            }
            lastUsedNanos = System.nanoTime();
            return response;
        } catch (Exception failed) {
            terminate();
            throw failed;
        }
    }

    private <T> T boundedIO(Callable<T> operation, long deadline) throws Exception {
        var task = new FutureTask<>(operation);
        Thread worker = Thread.ofVirtual().name("tts-piper-stdio").start(task);
        try {
            long remaining = TtsProcessInput.remainingNanos(deadline);
            if (remaining == 0) throw new TimeoutException("Piper deadline");
            return task.get(remaining, TimeUnit.NANOSECONDS);
        } catch (TimeoutException timeout) {
            task.cancel(true);
            worker.interrupt();
            terminate();
            throw new IOException("Piper worker timeout");
        } catch (InterruptedException interrupted) {
            task.cancel(true);
            worker.interrupt();
            terminate();
            Thread.currentThread().interrupt();
            throw interrupted;
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause();
            if (cause instanceof Exception ex) throw ex;
            if (cause instanceof Error error) throw error;
            throw new IOException("Piper worker I/O failed");
        }
    }

    /** Explicit voice catalog refresh, model revocation or server shutdown. */
    synchronized void invalidate() { terminate(); }

    synchronized boolean running() {
        return process != null && process.isAlive();
    }

    private void reapIdle() {
        while (!Thread.currentThread().isInterrupted()) {
            try { Thread.sleep(1000); }
            catch (InterruptedException stopped) { break; }
            synchronized (this) {
                if (closed) break;
                if (process != null && System.nanoTime() - lastUsedNanos >= idleNanos) {
                    terminate();
                }
            }
        }
    }

    private void terminate() {
        if (process != null) {
            TtsProcessCleanup.terminate(process);
            process = null;
        }
        model = null;
        config = null;
        fingerprint = null;
        lastUsedNanos = 0;
    }

    private static String fingerprint(Path model, Path config) throws Exception {
        if (!Files.isRegularFile(model, LinkOption.NOFOLLOW_LINKS)
            || !Files.isRegularFile(config, LinkOption.NOFOLLOW_LINKS)
            || Files.isSymbolicLink(model) || Files.isSymbolicLink(config)) {
            throw new IllegalArgumentException("unsafe Piper model path");
        }
        return hash(model, MAX_MODEL_BYTES) + ":" + hash(config, MAX_CONFIG_BYTES);
    }

    private static String hash(Path path, long limit) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long count = 0;
        try (var stream = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
            byte[] block = new byte[64 * 1024];
            int size;
            while ((size = stream.read(block)) != -1) {
                count += size;
                if (count > limit) throw new IllegalArgumentException("Piper model too large");
                digest.update(block, 0, size);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    @Override public void close() {
        if (closed) return;
        closed = true;
        reaper.interrupt();
        // Interrupt a long-running native inference before waiting for its
        // synchronized response reader. Shutdown must not wait 30 seconds.
        Process running = process;
        if (running != null && running.isAlive()) running.destroyForcibly();
        synchronized (this) { terminate(); }
    }
}
