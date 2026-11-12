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

        // Transport telemetry must not expose a client-supplied close
        // reason, endpoint, identity or unbounded code.
        require(BoardGameWebSocketServer.abnormalCloseTelemetry(1000, true)
            .isEmpty(), "normal close 1000 has no abnormal diagnostic");
        require(BoardGameWebSocketServer.abnormalCloseTelemetry(1001, false)
            .isEmpty(), "going-away close 1001 has no abnormal diagnostic");
        require(BoardGameWebSocketServer.abnormalCloseTelemetry(1006, true)
            .equals(" closeCode=1006 peerInitiated=true"),
            "transport abort preserves bounded close code and peer initiator");
        require(BoardGameWebSocketServer.abnormalCloseTelemetry(1008, false)
            .equals(" closeCode=1008 peerInitiated=false"),
            "local policy close preserves its fixed numeric classification");
        require(BoardGameWebSocketServer.abnormalCloseTelemetry(1013, false)
            .equals(" closeCode=1013 peerInitiated=false"),
            "local retryable SQL outage preserves its fixed code");
        require(BoardGameWebSocketServer.abnormalCloseTelemetry(-42, true)
            .equals(" closeCode=0 peerInitiated=true"),
            "out-of-range close code never reaches the log");
        require(BoardGameWebSocketServer.abnormalCloseTelemetry(
            Integer.MAX_VALUE, false).equals(
                " closeCode=0 peerInitiated=false"),
            "unbounded close code never reaches the log");

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
