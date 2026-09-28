package io.github.playcosmos.broadcastinggameplatform.platform.events;

public record DonationEvent(
    String provider,
    String channelId,
    String userId,
    String nickname,
    int amount,
    String unit,
    int supporterOrder,
    String rawPayload,
    long occurredAtEpochMs
) implements PlatformEvent {
    @Override
    public String type() {
        return "donation";
    }
}
