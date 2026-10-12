package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

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
        int retainedJobs, List<String> engineIds
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
    private final List<TtsEngine> engines;
    private final TtsPreferencesStore preferences;
    private final ArrayBlockingQueue<Entry> pending =
        new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    private final LinkedHashMap<String, Entry> jobs = new LinkedHashMap<>();
    private final Object guard = new Object();
    private final AtomicBoolean running = new AtomicBoolean(true);
    private final Thread worker;
    private volatile String activeJobId;

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
        Objects.requireNonNull(engines, "engines");
        this.engines = List.copyOf(engines);
        this.preferences = preferences;
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
        for (var engine : engines) {
            try {
                for (Voice voice : engine.voices()) {
                    if (voice != null && engine.id().equals(voice.engineId())) {
                        result.add(voice);
                    }
                }
            } catch (Exception error) {
                System.err.println("[tts] voice discovery failed for "
                    + engine.id() + ": " + error.getClass().getSimpleName());
            }
        }
        return List.copyOf(result);
    }

    /** Explicit refresh after installing or removing voice packages. */
    public List<Voice> refreshVoices() {
        for (var engine : engines) engine.invalidateVoiceCatalog();
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
            Entry entry = jobs.get(id);
            return entry == null ? null : entry.snapshot();
        }
    }

    public byte[] audio(String id) {
        synchronized (guard) {
            Entry entry = jobs.get(id);
            return entry == null || entry.audio == null
                ? null : entry.audio.clone();
        }
    }

    public Status status() {
        synchronized (guard) {
            return new Status(!engines.isEmpty(), pending.size(), activeJobId,
                jobs.size(), engines.stream().map(TtsEngine::id).toList());
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
            if (entry == null) continue;
            synchronized (guard) {
                if ("CANCELLED".equals(entry.state)) continue;
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
                if (wav == null || wav.length < 44
                    || wav.length > MAX_AUDIO_BYTES
                    || wav[0] != 'R' || wav[1] != 'I'
                    || wav[2] != 'F' || wav[3] != 'F') {
                    throw new IllegalStateException("invalid or oversized WAV");
                }
                entry.audio = wav.clone();
                entry.state = "READY";
            } catch (Exception error) {
                entry.error = "speech synthesis failed: "
                    + error.getClass().getSimpleName();
                entry.state = "FAILED";
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

    /** Preserve all active/queued entries; expire oldest terminal entries. */
    private void pruneCompleted() {
        if (jobs.size() < RETAINED_JOBS) return;
        var iterator = jobs.entrySet().iterator();
        while (iterator.hasNext() && jobs.size() >= RETAINED_JOBS) {
            Entry entry = iterator.next().getValue();
            if (!"QUEUED".equals(entry.state)
                && !"SYNTHESIZING".equals(entry.state)) {
                iterator.remove();
            }
        }
    }

    @Override
    public void close() {
        if (!running.compareAndSet(true, false)) return;
        clearQueued();
        worker.interrupt();
        try { worker.join(1500); }
        catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
        synchronized (guard) { jobs.clear(); }
    }
}
