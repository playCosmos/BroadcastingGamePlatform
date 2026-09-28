package io.github.playcosmos.broadcastinggameplatform.platform.events;

public record ChannelEvent(
    String provider,
    String channelId,
    String eventType,
    String rawPayload,
    long occurredAtEpochMs
) implements PlatformEvent {
    @Override
    public String type() {
        return "channel";
    }
}
