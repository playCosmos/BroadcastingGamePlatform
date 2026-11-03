package io.github.playcosmos.broadcastinggameplatform.boardserver;

import java.net.URI;
import java.util.Set;
import java.util.List;
import java.util.ArrayList;
import java.util.HashSet;

public record BoardServerConfig(
    String streamerId,
    Server server,
    Storage storage,
    Soop soop
) {
    public static BoardServerConfig defaults() {
        return new BoardServerConfig(
            "",
            new Server(
                "127.0.0.1",
                17830,
                17831,
                true,
                "0.0.0.0",
                17832,
                "",
                ""
            ),
            new Storage("./data/platform.db", "./web", "./logs"),
            new Soop(true, 30)
        );
    }

    public BoardServerConfig normalized() {
        var d = defaults();
        String id = streamerId == null ? "" : streamerId.trim();
        if ("STREAMER_ID".equals(id)) id = "";
        var normalizedSoop = soop == null ? d.soop : soop.normalized();
        if (!id.isBlank()
            && normalizedSoop.additionalStreamerIds().contains(id))
            throw new IllegalArgumentException(
                "SOOP primary cannot also be an additional source");
        if (normalizedSoop.additionalStreamerIds().size()
            + (id.isBlank() ? 0 : 1) > 8)
            throw new IllegalArgumentException(
                "at most eight SOOP streams including primary");
        return new BoardServerConfig(
            id,
            server == null ? d.server : server.normalized(),
            storage == null ? d.storage : storage.normalized(),
            normalizedSoop
        );
    }

    public record Server(
        String host,
        int port,
        int websocketPort,
        boolean openBrowserOnStart,
        String clientHost,
        int clientPort,
        String publicBaseUrl,
        String publicWebSocketUrl
    ) {
        Server normalized() {
            String adminHost = normalizeAdminHost(host);
            int adminPort = validPort(port, 17830);
            int wsPort = validPort(websocketPort, 17831);
            String publicHost = valueOrDefault(clientHost, "0.0.0.0");
            int publicPort = validPort(clientPort, 17832);

            return new Server(
                adminHost,
                adminPort,
                wsPort,
                openBrowserOnStart,
                publicHost,
                publicPort,
                normalizePublicUrl(
                    publicBaseUrl,
                    "publicBaseUrl",
                    Set.of("http", "https")
                ),
                normalizePublicUrl(
                    publicWebSocketUrl,
                    "publicWebSocketUrl",
                    Set.of("ws", "wss")
                )
            );
        }

        private static String normalizeAdminHost(
            String value
        ) {
            String host = valueOrDefault(value, "127.0.0.1");
            if ("localhost".equalsIgnoreCase(host)) {
                return "localhost";
            }
            if ("127.0.0.1".equals(host) || "::1".equals(host)) {
                return host;
            }
            throw new IllegalArgumentException(
                "server.host must be a loopback address"
            );
        }

        private static int validPort(int value, int fallback) {
            return value > 0 && value <= 65535 ? value : fallback;
        }

        private static String valueOrDefault(String value, String fallback) {
            return value == null || value.isBlank() ? fallback : value.trim();
        }

        private static String normalizePublicUrl(
            String value,
            String name,
            Set<String> allowedSchemes
        ) {
            if (value == null || value.isBlank()) return "";
            String normalized = value.trim();
            while (normalized.endsWith("/")) {
                normalized = normalized.substring(
                    0,
                    normalized.length() - 1
                );
            }

            final URI uri;
            try {
                uri = URI.create(normalized);
            } catch (RuntimeException error) {
                throw new IllegalArgumentException(
                    name + " must be a valid absolute URL",
                    error
                );
            }

            String scheme = uri.getScheme();
            if (
                scheme == null
                    || !allowedSchemes.contains(
                        scheme.toLowerCase(
                            java.util.Locale.ROOT
                        )
                    )
                    || uri.getHost() == null
                    || uri.getHost().isBlank()
                    || uri.getUserInfo() != null
                    || uri.getRawQuery() != null
                    || uri.getRawFragment() != null
            ) {
                throw new IllegalArgumentException(
                    name + " uses an unsupported URL"
                );
            }
            return normalized;
        }
    }

    public record Storage(String databasePath, String webRoot, String logDirectory) {
        Storage normalized() {
            return new Storage(
                valueOrDefault(databasePath, "./data/platform.db"),
                valueOrDefault(webRoot, "./web"),
                valueOrDefault(logDirectory, "./logs")
            );
        }

        private static String valueOrDefault(String value, String fallback) {
            return value == null || value.isBlank() ? fallback : value.trim();
        }
    }

    /**
     * Trusted operator-provisioned SOOP sources. streamerId at the document
     * root stays the primary/legacy broadcaster. Additional sources never
     * grant public guests the ability to open arbitrary provider sessions.
     */
    public record Soop(boolean enabled, int offlinePollSeconds,
                       List<String> additionalStreamerIds) {
        public Soop(boolean enabled, int offlinePollSeconds) {
            this(enabled, offlinePollSeconds, List.of());
        }

        Soop normalized() {
            var extra = new ArrayList<String>();
            var seen = new HashSet<String>();
            if (additionalStreamerIds != null) {
                if (additionalStreamerIds.size() > 8)
                    throw new IllegalArgumentException(
                        "at most eight additional SOOP streamer IDs");
                for (String raw : additionalStreamerIds) {
                    String id = raw == null ? "" : raw.trim();
                    if (!id.matches("[A-Za-z0-9_.:-]{1,128}"))
                        throw new IllegalArgumentException(
                            "invalid additional SOOP streamer ID");
                    if (!seen.add(id))
                        throw new IllegalArgumentException(
                            "duplicate additional SOOP streamer ID");
                    extra.add(id);
                }
            }
            return new Soop(enabled,
                offlinePollSeconds >= 5 ? offlinePollSeconds : 30,
                List.copyOf(extra));
        }
    }
}
