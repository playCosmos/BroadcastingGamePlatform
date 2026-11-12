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
