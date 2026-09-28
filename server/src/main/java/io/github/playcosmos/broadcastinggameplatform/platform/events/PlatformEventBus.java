package io.github.playcosmos.broadcastinggameplatform.platform.events;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

public final class PlatformEventBus {
    private static final int RECENT_LIMIT = 256;

    private final CopyOnWriteArrayList<Subscription<?>> subscriptions =
        new CopyOnWriteArrayList<>();
    private final ArrayDeque<PlatformEvent> recent = new ArrayDeque<>();

    public <T extends PlatformEvent> AutoCloseable subscribe(
        Class<T> type,
        Consumer<T> consumer
    ) {
        var subscription = new Subscription<>(type, consumer);
        subscriptions.add(subscription);
        return () -> subscriptions.remove(subscription);
    }

    public void publish(PlatformEvent event) {
        if (event == null) return;

        synchronized (recent) {
            recent.addLast(event);
            while (recent.size() > RECENT_LIMIT) {
                recent.removeFirst();
            }
        }

        for (var subscription : subscriptions) {
            subscription.accept(event);
        }
    }

    public List<PlatformEvent> recent(int requestedLimit) {
        int limit = Math.max(1, Math.min(RECENT_LIMIT, requestedLimit));
        synchronized (recent) {
            var all = new ArrayList<>(recent);
            int from = Math.max(0, all.size() - limit);
            return List.copyOf(all.subList(from, all.size()));
        }
    }

    private record Subscription<T extends PlatformEvent>(
        Class<T> type,
        Consumer<T> consumer
    ) {
        void accept(PlatformEvent event) {
            if (!type.isInstance(event)) return;
            consumer.accept(type.cast(event));
        }
    }
}
