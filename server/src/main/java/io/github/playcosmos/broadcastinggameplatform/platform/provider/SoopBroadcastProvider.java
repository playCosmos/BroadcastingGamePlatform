package io.github.playcosmos.broadcastinggameplatform.platform.provider;

import io.github.playcosmos.broadcastinggameplatform.config.BridgeConfig;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChannelEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.events.DonationEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.soop.SoopBridgeAdapter;
import io.github.playcosmos.broadcastinggameplatform.soop.SoopRuntimeState;
import java.util.Map;
import java.util.Objects;

public final class SoopBroadcastProvider implements BroadcastProvider {
    public static final String ID = "SOOP";

    private final SoopRuntimeState state;
    private final SoopBridgeAdapter adapter;

    public SoopBroadcastProvider(
        BridgeConfig config,
        PlatformEventBus eventBus
    ) {
        Objects.requireNonNull(eventBus, "eventBus");
        this.state = new SoopRuntimeState(config.streamerId());
        this.adapter = new SoopBridgeAdapter(
            config,
            state,
            donation -> eventBus.publish(
                new DonationEvent(
                    ID,
                    donation.streamerId(),
                    donation.donorId(),
                    donation.nickname(),
                    donation.balloonCount(),
                    "balloon",
                    donation.fanOrder(),
                    donation.rawPayload(),
                    donation.receivedAtEpochMs()
                )
            ),
            (channelId, event) -> eventBus.publish(
                new ChannelEvent(
                    ID,
                    channelId,
                    event == null
                        ? "unknown"
                        : event.getClass().getSimpleName(),
                    String.valueOf(event),
                    System.currentTimeMillis()
                )
            )
        );
    }

    @Override
    public String id() {
        return ID;
    }

    @Override
    public void start() {
        adapter.start();
    }

    @Override
    public void reconnect() {
        adapter.reconnectNow();
    }

    @Override
    public Map<String, Object> snapshot() {
        return state.snapshot();
    }

    public String status() {
        return state.status();
    }

    @Override
    public void close() {
        adapter.close();
    }
}
