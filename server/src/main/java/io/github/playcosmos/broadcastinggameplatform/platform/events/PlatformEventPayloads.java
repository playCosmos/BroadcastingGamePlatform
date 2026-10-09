package io.github.playcosmos.broadcastinggameplatform.platform.events;

public final class PlatformEventPayloads {
    public static final int MAX_IDENTIFIER_CHARS = 256;
    public static final int MAX_DISPLAY_NAME_CHARS = 256;
    public static final int MAX_CHAT_MESSAGE_CHARS = 8 * 1024;
    public static final int MAX_RAW_PAYLOAD_CHARS = 64 * 1024;

    private PlatformEventPayloads() {}

    public static String boundedIdentifier(String value) {
        return bounded(value, MAX_IDENTIFIER_CHARS);
    }

    public static String boundedDisplayName(String value) {
        return bounded(value, MAX_DISPLAY_NAME_CHARS);
    }

    public static String boundedChatMessage(String value) {
        return bounded(value, MAX_CHAT_MESSAGE_CHARS);
    }

    public static String boundedRawPayload(String value) {
        return bounded(value, MAX_RAW_PAYLOAD_CHARS);
    }

    private static String bounded(String value, int maxChars) {
        if (value == null || value.length() <= maxChars) {
            return value;
        }
        int end = maxChars;
        if (
            end > 0
                && Character.isHighSurrogate(value.charAt(end - 1))
                && end < value.length()
                && Character.isLowSurrogate(value.charAt(end))
        ) {
            end -= 1;
        }
        return value.substring(0, end);
    }
}
