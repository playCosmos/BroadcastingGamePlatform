package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;

/**
 * Independent, bounded TTS foundation. No game/provider event subscriptions.
 * Voice implementations are registered through the TtsEngine interface.
 */
public final class TtsService implements AutoCloseable {
    public interface TtsEngine {
        String id();
        List<Voice> voices() throws Exception;
        default void invalidateVoiceCatalog() {}
        byte[] synthesize(String voiceId, String text, int rate, int volume)
            throws Exception;
    }

    public record Voice(
        String id, String engineId, String name, String language,
        String gender, List<String> styles, String source
    ) {
        public Voice {
            Objects.requireNonNull(id, "id");
            Objects.requireNonNull(engineId, "engineId");
            Objects.requireNonNull(name, "name");
            Objects.requireNonNull(language, "language");
            gender = gender == null ? "unknown" : gender;
            styles = styles == null ? List.of() : List.copyOf(styles);
            source = source == null ? "engine" : source;
        }

        /** Preserve the four-field adapter contract for older engines. */
        public Voice(String id, String engineId, String name, String language) {
            this(id, engineId, name, language, "unknown", List.of(), "engine");
        }
    }
    public record Job(
        String id, String status, String voiceId, long createdAt,
        String error, boolean audioAvailable
    ) {}
    public record Status(
        boolean available, int queued, String activeJobId,
        int retainedJobs, List<String> engineIds,
        int retainedAudioBytes, int maxRetainedAudioBytes
    ) {}
    public record Request(
        String text, String voiceId, int rate, int volume
    ) {}
    public static final class CapacityException extends IllegalStateException {
        public CapacityException(String message) { super(message); }
    }

    private static final int QUEUE_CAPACITY = 16;
    private static final int RETAINED_JOBS = 24;
    private static final int MAX_AUDIO_BYTES = 5 * 1024 * 1024;
    // Limit cached previews independently of the number of retained job records.
    private static final int MAX_RETAINED_AUDIO_BYTES = 16 * 1024 * 1024;
    // Preview WAVs are transient. Expire 15 minutes after synthesis completes.
    private static final long AUDIO_RETENTION_NANOS = TimeUnit.MINUTES.toNanos(15);
    private final List<TtsEngine> engines;
    private final TtsPreferencesStore preferences;
    private final LongSupplier monotonicNanos;
    private final ArrayBlockingQueue<Entry> pending =
        new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    private final LinkedHashMap<String, Entry> jobs = new LinkedHashMap<>();
    private final Object guard = new Object();
    private final AtomicBoolean running = new AtomicBoolean(true);
    private final Thread worker;
    private volatile String activeJobId;
    // Read and written only while holding guard.
    private int retainedAudioBytes;

    private static final class Entry {
        final String id = UUID.randomUUID().toString();
        final String voiceId;
        final String text;
        final int rate;
        final int volume;
        final long createdAt = Instant.now().toEpochMilli();
        volatile String state = "QUEUED";
        volatile String error;
        volatile byte[] audio;
        long audioReadyAtNanos; // guarded by TtsService.guard

        Entry(Request request) {
            voiceId = request.voiceId();
            text = request.text();
            rate = request.rate();
            volume = request.volume();
        }
        Job snapshot() {
            return new Job(id, state, voiceId, createdAt, error, audio != null);
        }
    }

    public TtsService(List<TtsEngine> engines) {
        this(engines, null);
    }

    public TtsService(List<TtsEngine> engines, TtsPreferencesStore preferences) {
        this(engines, preferences, System::nanoTime);
    }

    // Package-private clock seam keeps retention tests deterministic.
    TtsService(List<TtsEngine> engines, TtsPreferencesStore preferences,
               LongSupplier monotonicNanos) {
        Objects.requireNonNull(engines, "engines");
        this.engines = List.copyOf(engines);
        this.preferences = preferences;
        this.monotonicNanos = Objects.requireNonNull(monotonicNanos, "monotonicNanos");
        if (this.engines.stream().anyMatch(Objects::isNull)) {
            throw new IllegalArgumentException("null engine");
        }
        if (this.engines.stream().map(TtsEngine::id).distinct().count()
            != this.engines.size()) {
            throw new IllegalArgumentException("duplicate engine ID");
        }
        worker = Thread.ofVirtual().name("platform-tts-worker")
            .start(this::work);
    }

    public TtsPreferencesStore.Preferences settings() {
        return preferences == null
            ? new TtsPreferencesStore.Preferences("", 0, 80)
            : preferences.get();
    }

    public TtsPreferencesStore.Preferences saveSettings(
        TtsPreferencesStore.Preferences next
    ) throws IOException {
        if (preferences == null) throw new IllegalStateException("settings unavailable");
        // Voice may have been uninstalled. Preserve its identifier so the UI
        // can display a missing-voice warning without silently replacing it.
        return preferences.save(next);
    }

    public List<Voice> voices() {
        var result = new ArrayList<Voice>();
        var seen = new HashSet<String>();
        for (var engine : engines) {
            try {
                for (Voice voice : engine.voices()) {
                    if (voice != null && engine.id().equals(voice.engineId())
                        && voice.id().startsWith(engine.id() + "/")
                        && voice.id().length() > engine.id().length() + 1
                        && seen.add(voice.id())) {
                        result.add(voice);
                    }
                }
            } catch (Exception | LinkageError error) {
                System.err.println("[tts] voice discovery failed for "
                    + engine.id() + ": " + error.getClass().getSimpleName());
            }
        }
        return List.copyOf(result);
    }

    /** Explicit refresh after installing or removing voice packages. */
    public List<Voice> refreshVoices() {
        for (var engine : engines) {
            try {
                engine.invalidateVoiceCatalog();
            } catch (Exception | LinkageError error) {
                // A broken optional voice adapter must not disable the admin API.
                System.err.println("[tts] voice refresh failed for "
                    + engine.id() + ": " + error.getClass().getSimpleName());
            }
        }
        return voices();
    }

    public Job enqueue(Request request) {
        Objects.requireNonNull(request, "request");
        String text = request.text() == null ? "" : request.text().strip();
        if (text.isEmpty() || text.codePointCount(0, text.length()) > 200) {
            throw new IllegalArgumentException("text must be 1–200 characters");
        }
        if (text.chars().anyMatch(ch ->
            ch == 0 || ch == 127 || (ch < 32 && ch != '\n' && ch != '\t')
        )) {
            throw new IllegalArgumentException("unsupported control character");
        }
        if (request.rate() < -10 || request.rate() > 10
            || request.volume() < 0 || request.volume() > 100) {
            throw new IllegalArgumentException("rate or volume out of range");
        }
        var selected = voices().stream().filter(voice ->
            voice.id().equals(request.voiceId())
        ).findFirst().orElseThrow(() ->
            new IllegalArgumentException("voice is unavailable")
        );
        if (!running.get()) throw new IllegalStateException("TTS closed");
        Entry entry = new Entry(new Request(
            text, selected.id(), request.rate(), request.volume()
        ));
        synchronized (guard) {
            if (!running.get()) throw new IllegalStateException("TTS closed");
            expireStaleAudio();
            pruneCompleted();
            if (jobs.size() >= RETAINED_JOBS || !pending.offer(entry)) {
                throw new CapacityException("TTS queue is full");
            }
            jobs.put(entry.id, entry);
        }
        return entry.snapshot();
    }

    public Job job(String id) {
        synchronized (guard) {
            expireStaleAudio();
            Entry entry = jobs.get(id);
            return entry == null ? null : entry.snapshot();
        }
    }

    public byte[] audio(String id) {
        synchronized (guard) {
            expireStaleAudio();
            Entry entry = jobs.get(id);
            return entry == null || entry.audio == null
                ? null : entry.audio.clone();
        }
    }

    public Status status() {
        synchronized (guard) {
            expireStaleAudio();
            return new Status(!engines.isEmpty(), pending.size(), activeJobId,
                jobs.size(), engines.stream().map(TtsEngine::id).toList(),
                retainedAudioBytes, MAX_RETAINED_AUDIO_BYTES);
        }
    }

    /** Discards queued jobs, but does not interrupt a currently synthesizing job. */
    public int clearQueued() {
        synchronized (guard) {
            int removed = 0;
            Entry item;
            while ((item = pending.poll()) != null) {
                item.state = "CANCELLED";
                removed++;
            }
            return removed;
        }
    }

    private void work() {
        while (running.get()) {
            Entry entry;
            try {
                entry = pending.poll(1, TimeUnit.SECONDS);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                break;
            }
            if (entry == null) {
                // Reclaim previews even when no administrators poll the API.
                synchronized (guard) { expireStaleAudio(); }
                continue;
            }
            synchronized (guard) {
                if (!running.get() || "CANCELLED".equals(entry.state)) {
                    entry.state = "CANCELLED";
                    continue;
                }
                entry.state = "SYNTHESIZING";
                activeJobId = entry.id;
            }
            try {
                TtsEngine engine = engines.stream().filter(candidate ->
                    entry.voiceId.startsWith(candidate.id() + "/")
                ).findFirst().orElseThrow(() ->
                    new IllegalArgumentException("engine unavailable")
                );
                byte[] wav = engine.synthesize(entry.voiceId, entry.text,
                    entry.rate, entry.volume);
                if (!validWav(wav)) {
                    throw new IllegalStateException("invalid or oversized WAV");
                }
                synchronized (guard) {
                    if (running.get() && "SYNTHESIZING".equals(entry.state)) {
                        expireStaleAudio();
                        entry.audio = wav.clone();
                        entry.audioReadyAtNanos = monotonicNanos.getAsLong();
                        retainedAudioBytes += entry.audio.length;
                        entry.state = "READY";
                        evictOldAudio(entry);
                    }
                }
            } catch (Exception | LinkageError error) {
                synchronized (guard) {
                    if (running.get() && "SYNTHESIZING".equals(entry.state)) {
                        entry.error = "speech synthesis failed: "
                            + error.getClass().getSimpleName();
                        entry.state = "FAILED";
                    }
                }
                System.err.println("[tts] job failed id=" + entry.id
                    + " engine=" + entry.voiceId.split("/", 2)[0]
                    + " reason=" + error.getClass().getSimpleName());
            } finally {
                synchronized (guard) {
                    if (entry.id.equals(activeJobId)) activeJobId = null;
                    pruneCompleted();
                }
            }
        }
    }

    /**
     * Validate RIFF/WAVE framing without imposing a particular PCM encoding.
     * Bounds-check chunks before audio is exposed by the admin preview API.
     */
    private static boolean validWav(byte[] wav) {
        if (wav == null || wav.length < 44 || wav.length > MAX_AUDIO_BYTES
            || !tag(wav, 0, "RIFF") || !tag(wav, 8, "WAVE")) return false;
        long declared = uint32(wav, 4) + 8L;
        if (declared != wav.length) return false;
        boolean format = false;
        boolean data = false;
        long cursor = 12;
        while (cursor + 8 <= wav.length) {
            int pos = (int) cursor;
            long size = uint32(wav, pos + 4);
            long end = cursor + 8L + size;
            if (end > wav.length) return false;
            if (tag(wav, pos, "fmt ")) {
                // A RIFF frame with a zero-channel/zero-rate format is not
                // playable even if all chunk boundaries are technically valid.
                if (size < 16
                    || (wav[pos + 10] & 255 | (wav[pos + 11] & 255) << 8) == 0
                    || uint32(wav, pos + 12) == 0
                    || uint32(wav, pos + 16) == 0) return false;
                format = true;
            }
            if (tag(wav, pos, "data")) {
                if (size == 0) return false;
                data = true;
            }
            cursor = end + (size & 1L);
        }
        return cursor == wav.length && format && data;
    }

    private static boolean tag(byte[] bytes, int offset, String value) {
        for (int i = 0; i < value.length(); i++) {
            if (bytes[offset + i] != (byte) value.charAt(i)) return false;
        }
        return true;
    }

    private static long uint32(byte[] bytes, int offset) {
        return (bytes[offset] & 255L) | ((bytes[offset + 1] & 255L) << 8)
            | ((bytes[offset + 2] & 255L) << 16)
            | ((bytes[offset + 3] & 255L) << 24);
    }

    /** Expire previews by synthesis completion time, using a monotonic clock. */
    private void expireStaleAudio() {
        long now = monotonicNanos.getAsLong();
        for (Entry entry : jobs.values()) {
            if (entry.audio != null && "READY".equals(entry.state)
                && now - entry.audioReadyAtNanos >= AUDIO_RETENTION_NANOS) {
                expireAudio(entry, "audio expired after retention window");
            }
        }
    }

    private void expireAudio(Entry entry, String reason) {
        if (entry.audio == null) return;
        retainedAudioBytes -= entry.audio.length;
        entry.audio = null;
        entry.state = "EXPIRED";
        entry.error = reason;
    }

    /** Evict oldest previews first while preserving their job metadata. */
    private void evictOldAudio(Entry newest) {
        if (retainedAudioBytes <= MAX_RETAINED_AUDIO_BYTES) return;
        for (Entry previous : jobs.values()) {
            if (previous == newest || previous.audio == null) continue;
            expireAudio(previous, "audio expired from preview cache");
            if (retainedAudioBytes <= MAX_RETAINED_AUDIO_BYTES) break;
        }
    }

    /** Preserve active/queued jobs; remove the oldest terminal job records. */
    private void pruneCompleted() {
        if (jobs.size() < RETAINED_JOBS) return;
        var iterator = jobs.entrySet().iterator();
        while (iterator.hasNext() && jobs.size() >= RETAINED_JOBS) {
            Entry entry = iterator.next().getValue();
            if (!"QUEUED".equals(entry.state)
                && !"SYNTHESIZING".equals(entry.state)) {
                if (entry.audio != null) {
                    retainedAudioBytes -= entry.audio.length;
                    entry.audio = null;
                }
                iterator.remove();
            }
        }
    }

    @Override
    public void close() {
        synchronized (guard) {
            if (!running.compareAndSet(true, false)) return;
            clearQueued();
            if (activeJobId != null) {
                Entry active = jobs.get(activeJobId);
                if (active != null) active.state = "CANCELLED";
            }
        }
        worker.interrupt();
        try { worker.join(1500); }
        catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
        synchronized (guard) {
            jobs.clear();
            retainedAudioBytes = 0;
        }
    }
}
