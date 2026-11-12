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

        // An untrusted WebSocket library exception can carry URL query
        // parameters, bearer data, or peer-provided text. Only emit fixed
        // coarse categories, never an exception message or class name.
        require(BoardGameWebSocketServer.transportErrorCategory(
            new java.io.IOException("fixture-private-uri")).equals("io"),
            "I/O errors have a fixed non-secret category");
        require(BoardGameWebSocketServer.transportErrorCategory(
            new java.sql.SQLException("fixture-private-token")).equals("database"),
            "JDBC errors have a fixed non-secret category");
        require(BoardGameWebSocketServer.transportErrorCategory(
            new IllegalArgumentException("fixture-private-request"))
                .equals("protocol"),
            "invalid transport data has a fixed non-secret category");
        require(BoardGameWebSocketServer.transportErrorCategory(
            new Exception("fixture-private-member")).equals("other"),
            "unknown exception text never reaches the server log");
        require(BoardGameWebSocketServer.transportErrorCategory(null)
            .equals("other"), "missing exception remains a fixed category");

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

        // Both invalid drawer payloads and internal persistence failures
        // must return the same constant JSON without echoing private input.
        String expectedDrawingError =
            "{\"type\":\"drawing.error\",\"message\":\"drawing request failed\"}";
        for (Exception secretBearing : new Exception[]{
            new IllegalArgumentException(
                "fixture-private-path /tmp/secret/credential"),
            new java.sql.SQLException(
                "fixture-private-sql bearer=do-not-echo"),
            new IllegalStateException(
                "fixture-private-room-member")
        }) {
            String frame = BoardGameWebSocketServer.safeDrawingErrorFrame(
                secretBearing);
            require(frame.equals(expectedDrawingError),
                "legacy drawing error must have fixed protocol JSON");
            var obj = com.google.gson.JsonParser.parseString(frame)
                .getAsJsonObject();
            require(obj.size() == 2 &&
                "drawing.error".equals(obj.get("type").getAsString()) &&
                "drawing request failed".equals(
                    obj.get("message").getAsString()),
                "legacy error shape remains client compatible");
            require(!frame.contains("fixture-private"),
                "legacy drawing response may not echo exception contents");
        }
        require(BoardGameWebSocketServer.safeDrawingErrorFrame(null)
            .equals(expectedDrawingError),
            "missing exception still has a fixed response frame");

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
