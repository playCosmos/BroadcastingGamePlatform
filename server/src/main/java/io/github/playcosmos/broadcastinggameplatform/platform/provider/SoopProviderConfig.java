package io.github.playcosmos.broadcastinggameplatform.platform.provider;

public record SoopProviderConfig(
    String streamerId,
    boolean enabled,
    int offlinePollSeconds
) {
    public SoopProviderConfig normalized() {
        String normalizedStreamerId =
            streamerId == null ? "" : streamerId.trim();
        if ("STREAMER_ID".equals(normalizedStreamerId)) {
            normalizedStreamerId = "";
        }
        int poll = offlinePollSeconds >= 5
            ? offlinePollSeconds
            : 30;
        return new SoopProviderConfig(
            normalizedStreamerId,
            enabled,
            poll
        );
    }
}
