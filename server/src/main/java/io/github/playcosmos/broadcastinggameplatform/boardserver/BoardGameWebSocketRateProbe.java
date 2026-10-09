package io.github.playcosmos.broadcastinggameplatform.boardserver;

public final class BoardGameWebSocketRateProbe {
    private BoardGameWebSocketRateProbe() {}

    public static void main(String[] args) {
        var window =
            new BoardGameWebSocketServer.HandshakeRateWindow();
        long start = 1_000_000_000L;

        for (int attempt = 0; attempt < 120; attempt += 1) {
            require(
                window.allow(start),
                "first 120 websocket handshakes must be allowed"
            );
        }
        require(
            !window.allow(start),
            "121st websocket handshake must be rate limited"
        );
        require(
            window.allow(start + 10_000_000_000L),
            "websocket handshake rate must reset after 10 seconds"
        );

        System.out.println(
            "Board websocket rate probe passed."
        );
    }

    private static void require(
        boolean condition,
        String message
    ) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
