package io.github.playcosmos.broadcastinggameplatform.soop;

public record SoopDonation(
    String streamerId,
    String donorId,
    String nickname,
    int balloonCount,
    int fanOrder,
    String rawPayload,
    long receivedAtEpochMs
) {}
