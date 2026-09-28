package io.github.playcosmos.broadcastinggameplatform.platform.events;

public sealed interface PlatformEvent
    permits DonationEvent, ChatMessageEvent, ChannelEvent {
    String provider();
    String type();
    long occurredAtEpochMs();
}
