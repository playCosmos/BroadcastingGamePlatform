package io.github.playcosmos.broadcastinggameplatform.platform.provider;

import io.github.playcosmos.broadcastinggameplatform.platform.events.ChannelEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChatMessageEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.events.DonationEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventPayloads;
import io.github.playcosmos.broadcastinggameplatform.soop.SoopBridgeAdapter;
import io.github.playcosmos.broadcastinggameplatform.soop.SoopRuntimeState;
import java.util.Map;
import java.util.Objects;

public final class SoopBroadcastProvider implements BroadcastProvider {
    public static final String ID = "SOOP";

    private final SoopRuntimeState state;
    private final SoopBridgeAdapter adapter;

    public SoopBroadcastProvider(
        SoopProviderConfig config,
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
            (channelId, event) -> {
                if (
                    event instanceof
                        com.github.getcurrentthread.soopapi.event.model.ChatMessageEvent chat
                ) {
                    state.chatReceived();
                    eventBus.publish(
                        new ChatMessageEvent(
                            ID,
                            channelId,
                            chat.senderId(),
                            chat.senderNickname(),
                            chat.message(),
                            PlatformEventPayloads.boundedRawPayload(
                                chat.raw()
                            ),
                            chat.timestamp()
                        )
                    );
                    return;
                }

                if (
                    event instanceof
                        com.github.getcurrentthread.soopapi.event.model.SendBalloonEvent
                ) {
                    // DonationEvent is emitted by the dedicated donation sink.
                    return;
                }

                eventBus.publish(
                    new ChannelEvent(
                        ID,
                        channelId,
                        event == null
                            ? "unknown"
                            : event.getClass().getSimpleName(),
                        PlatformEventPayloads.boundedRawPayload(
                            String.valueOf(event)
                        ),
                        System.currentTimeMillis()
                    )
                );
            }
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
