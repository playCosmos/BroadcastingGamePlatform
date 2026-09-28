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
    public DonationEvent(
        String channelId,
        String userId,
        String nickname,
        int amount,
        int supporterOrder,
        String rawPayload,
        long occurredAtEpochMs
    ) {
        this(
            "SOOP",
            channelId,
            userId,
            nickname,
            amount,
            "balloon",
            supporterOrder,
            rawPayload,
            occurredAtEpochMs
        );
    }

    @Override
    public String type() {
        return "donation";
    }
}
