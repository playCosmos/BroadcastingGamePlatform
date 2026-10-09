package io.github.playcosmos.broadcastinggameplatform.platform.events;

public final class PlatformEventPayloads {
    public static final int MAX_RAW_PAYLOAD_CHARS = 64 * 1024;

    private PlatformEventPayloads() {}

    public static String boundedRawPayload(String value) {
        if (
            value == null
                || value.length() <= MAX_RAW_PAYLOAD_CHARS
        ) {
            return value;
        }
        return value.substring(0, MAX_RAW_PAYLOAD_CHARS);
    }
}
