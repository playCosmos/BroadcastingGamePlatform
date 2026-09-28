package io.github.playcosmos.broadcastinggameplatform.platform.events;

public record ChatMessageEvent(
    String provider,
    String channelId,
    String userId,
    String nickname,
    String message,
    String rawPayload,
    long occurredAtEpochMs
) implements PlatformEvent {
    @Override
    public String type() {
        return "chat.message";
    }
}
