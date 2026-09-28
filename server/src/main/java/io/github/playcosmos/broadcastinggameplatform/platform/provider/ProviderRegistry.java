package io.github.playcosmos.broadcastinggameplatform.platform.provider;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class ProviderRegistry implements AutoCloseable {
    private final Map<String, BroadcastProvider> providers =
        new LinkedHashMap<>();

    public synchronized void register(BroadcastProvider provider) {
        String id = normalize(provider.id());
        if (id.isBlank()) {
            throw new IllegalArgumentException("provider id is required");
        }
        if (providers.containsKey(id)) {
            throw new IllegalStateException("duplicate provider: " + id);
        }
        providers.put(id, provider);
    }

    public synchronized void startAll() {
        providers.values().forEach(BroadcastProvider::start);
    }

    public synchronized void reconnect(String providerId) {
        var provider = providers.get(normalize(providerId));
        if (provider == null) {
            throw new IllegalArgumentException(
                "provider not registered: " + providerId
            );
        }
        provider.reconnect();
    }

    public synchronized Map<String, Object> snapshot(String providerId) {
        var provider = providers.get(normalize(providerId));
        return provider == null ? Map.of() : provider.snapshot();
    }

    public synchronized List<Map<String, Object>> snapshots() {
        var result = new ArrayList<Map<String, Object>>();
        for (var provider : providers.values()) {
            var item = new LinkedHashMap<String, Object>();
            item.put("id", provider.id());
            item.putAll(provider.snapshot());
            result.add(item);
        }
        return List.copyOf(result);
    }

    @Override
    public synchronized void close() {
        var values = new ArrayList<>(providers.values());
        for (int index = values.size() - 1; index >= 0; index -= 1) {
            try {
                values.get(index).close();
            } catch (Exception ignored) {
            }
        }
        providers.clear();
    }

    private static String normalize(String value) {
        return value == null
            ? ""
            : value.trim().toUpperCase(Locale.ROOT);
    }
}
