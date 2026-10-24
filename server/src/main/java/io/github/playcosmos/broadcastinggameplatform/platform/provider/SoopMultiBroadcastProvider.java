package io.github.playcosmos.broadcastinggameplatform.platform.provider;

import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Bounded independent SOOP supervisors. Every configured stream has its own
 * SOOPClient, retry clock, generation guard and connection state. The server
 * operator, not a browser guest, must provision the streamer IDs.
 *
 * The first connection retains the legacy streamerId/status/dashboard fields.
 * Extra connection status is exposed in the "streams" diagnostic collection.
 */
public final class SoopMultiBroadcastProvider implements BroadcastProvider {
    public static final int MAX_STREAMS = 8;

    private final String primaryId;
    private final SoopBroadcastProvider primary;
    private final Map<String, SoopBroadcastProvider> sources;
    private final AtomicBoolean started = new AtomicBoolean();
    private final AtomicBoolean closed = new AtomicBoolean();

    public SoopMultiBroadcastProvider(
        String legacyStreamerId, List<String> additionalStreamerIds,
        boolean enabled, int offlinePollSeconds, PlatformEventBus events
    ) {
        Objects.requireNonNull(events, "events");
        var legacy = new SoopProviderConfig(legacyStreamerId, enabled,
            offlinePollSeconds).normalized();
        primaryId = legacy.streamerId();
        var entries = new LinkedHashMap<String, SoopBroadcastProvider>();
        // Keep the historical connection alive as the primary authority.
        primary = new SoopBroadcastProvider(legacy, events);
        if (!primaryId.isBlank()) entries.put(primaryId, primary);
        var seen = new LinkedHashSet<String>(entries.keySet());
        if (additionalStreamerIds != null) {
            if (additionalStreamerIds.size() > MAX_STREAMS)
                throw new IllegalArgumentException("too many SOOP sources");
            for (String raw : additionalStreamerIds) {
                String id = raw == null ? "" : raw.trim();
                if (!id.matches("[A-Za-z0-9_.:-]{1,128}"))
                    throw new IllegalArgumentException("invalid SOOP source");
                if (!seen.add(id))
                    throw new IllegalArgumentException("duplicate SOOP source");
                if (seen.size() > MAX_STREAMS)
                    throw new IllegalArgumentException("SOOP source budget exceeded");
                entries.put(id, new SoopBroadcastProvider(
                    new SoopProviderConfig(id, enabled, offlinePollSeconds), events));
            }
        }
        sources = java.util.Collections.unmodifiableMap(entries);
    }

    @Override public String id() { return SoopBroadcastProvider.ID; }

    public List<String> configuredStreamers() {
        return List.copyOf(sources.keySet());
    }

    @Override public void start() {
        if (closed.get() || !started.compareAndSet(false, true)) return;
        if (primaryId.isBlank()) primary.start();
        for (var source : sources.values()) source.start();
    }

    @Override public void reconnect() {
        if (closed.get()) return;
        if (primaryId.isBlank()) primary.reconnect();
        for (var source : sources.values()) source.reconnect();
    }

    /** Targeted operator reconnect: other streams and their retry state remain intact. */
    public void reconnect(String streamerId) {
        if (closed.get()) return;
        var source = sources.get(streamerId);
        if (source == null) throw new IllegalArgumentException(
            "SOOP source not configured");
        source.reconnect();
    }

    public String status() {
        if (sources.size() <= 1) {
            if (sources.isEmpty()) return primary.status();
            return sources.values().iterator().next().status();
        }
        long connected = sources.values().stream()
            .filter(x -> "CONNECTED".equals(x.status())).count();
        if (connected == sources.size()) return "CONNECTED";
        if (connected > 0) return "PARTIAL";
        if (sources.values().stream().allMatch(
            x -> "DISABLED".equals(x.status()))) return "DISABLED";
        return "NO_CONNECTED_STREAMS";
    }

    @Override public Map<String, Object> snapshot() {
        var result = new LinkedHashMap<String, Object>(primary.snapshot());
        var streams = new ArrayList<Map<String, Object>>();
        for (var entry : sources.entrySet()) {
            var one = new LinkedHashMap<String, Object>(entry.getValue().snapshot());
            one.put("primary", entry.getKey().equals(primaryId));
            streams.add(java.util.Collections.unmodifiableMap(one));
        }
        result.put("configuredStreams", streams.size());
        result.put("connectedStreams", streams.stream()
            .filter(s -> "CONNECTED".equals(s.get("status"))).count());
        result.put("aggregateStatus", status());
        result.put("streams", List.copyOf(streams));
        return java.util.Collections.unmodifiableMap(result);
    }

    @Override public void close() {
        if (!closed.compareAndSet(false, true)) return;
        var values = new ArrayList<SoopBroadcastProvider>(sources.values());
        for (int i = values.size() - 1; i >= 0; i--) values.get(i).close();
        if (primaryId.isBlank()) primary.close();
    }
}
