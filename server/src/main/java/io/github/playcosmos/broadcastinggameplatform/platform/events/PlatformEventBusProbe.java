package io.github.playcosmos.broadcastinggameplatform.platform.events;

import io.github.playcosmos.broadcastinggameplatform.platform.provider.BroadcastProvider;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

public final class PlatformEventBusProbe {
    private PlatformEventBusProbe() {}

    public static void main(String[] args) throws Exception {
        var bus = new PlatformEventBus();
        var donations = new AtomicInteger();
        var chats = new AtomicInteger();

        try (
            var failingDonationSubscription = bus.subscribe(
                DonationEvent.class,
                event -> {
                    throw new IllegalStateException("probe subscriber failure");
                }
            );
            var donationSubscription = bus.subscribe(
                DonationEvent.class,
                event -> donations.incrementAndGet()
            );
            var chatSubscription = bus.subscribe(
                ChatMessageEvent.class,
                event -> chats.incrementAndGet()
            )
        ) {
            bus.publish(
                new DonationEvent(
                    "SOOP",
                    "streamer-a",
                    "viewer-a",
                    "Viewer A",
                    100,
                    "balloon",
                    1,
                    "{}",
                    1L
                )
            );
            bus.publish(
                new ChatMessageEvent(
                    "SOOP",
                    "streamer-a",
                    "viewer-b",
                    "Viewer B",
                    "hello",
                    "{}",
                    2L
                )
            );
            bus.publish(
                new DonationEvent(
                    "CHZZK",
                    "channel-b",
                    "viewer-c",
                    "Viewer C",
                    1000,
                    "currency",
                    0,
                    "{}",
                    3L
                )
            );

            require(
                donations.get() == 2,
                "donation subscriptions must be provider-neutral"
            );
            require(
                bus.recent(3).size() == 3,
                "subscriber failure must not prevent event retention"
            );
            require(
                chats.get() == 1,
                "chat subscription must receive normalized chat messages"
            );
            require(
                bus.recent(2).size() == 2,
                "recent event limit must be applied"
            );
            require(
                "chat.message".equals(
                    bus.recent(2).get(0).type()
                ),
                "recent event order must remain chronological"
            );
        }

        require(
            PlatformEventPayloads.boundedRawPayload(
                "x".repeat(
                    PlatformEventPayloads.MAX_RAW_PAYLOAD_CHARS + 128
                )
            ).length()
                == PlatformEventPayloads.MAX_RAW_PAYLOAD_CHARS,
            "platform raw payloads must be bounded"
        );

        var registry = new ProviderRegistry();
        var fake = new FakeProvider();
        registry.register(fake);
        registry.startAll();
        require(fake.starts == 1, "provider registry must start providers");
        registry.reconnect("TEST");
        require(
            fake.reconnects == 1,
            "provider registry must route reconnect"
        );
        require(
            "CONNECTED".equals(
                registry.snapshot("TEST").get("status")
            ),
            "provider snapshot must be exposed"
        );
        registry.close();
        require(fake.closes == 1, "provider registry must close providers");

        System.out.println("Platform event/provider probe passed.");
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }

    private static final class FakeProvider
        implements BroadcastProvider {
        private int starts;
        private int reconnects;
        private int closes;

        @Override
        public String id() {
            return "TEST";
        }

        @Override
        public void start() {
            starts += 1;
        }

        @Override
        public void reconnect() {
            reconnects += 1;
        }

        @Override
        public Map<String, Object> snapshot() {
            var state = new LinkedHashMap<String, Object>();
            state.put("status", "CONNECTED");
            return state;
        }

        @Override
        public void close() {
            closes += 1;
        }
    }
}
