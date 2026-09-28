package io.github.playcosmos.broadcastinggameplatform.boardserver;

import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

public final class BoardGameWebSocketServer extends WebSocketServer {
    private static final Pattern CODE_PATTERN =
        Pattern.compile("[A-HJ-NP-Z2-9]{6}");

    private enum ChannelKind {
        BOARD,
        DRAWING
    }

    private record Channel(
        ChannelKind kind,
        String code,
        String drawerToken,
        boolean canWrite
    ) {}

    private final AtomicInteger connectedClients = new AtomicInteger();
    private final Map<WebSocket, Channel> channelByConnection =
        new ConcurrentHashMap<>();
    private final Predicate<String> roomCodeValidator;
    private final DrawingSyncService drawingSync;

    public BoardGameWebSocketServer(String host, int port) {
        this(host, port, roomCode -> true, null);
    }

    public BoardGameWebSocketServer(
        String host,
        int port,
        Predicate<String> roomCodeValidator
    ) {
        this(host, port, roomCodeValidator, null);
    }

    public BoardGameWebSocketServer(
        String host,
        int port,
        Predicate<String> roomCodeValidator,
        DrawingSyncService drawingSync
    ) {
        super(new InetSocketAddress(host, port));
        this.roomCodeValidator = roomCodeValidator == null
            ? roomCode -> false
            : roomCodeValidator;
        this.drawingSync = drawingSync;
        setReuseAddr(true);
    }

    @Override
    public void onOpen(WebSocket connection, ClientHandshake handshake) {
        Map<String, String> query = queryParameters(handshake);
        String roomCode = normalizeCode(query.get("roomCode"));
        if (roomCode != null) {
            if (!roomCodeValidator.test(roomCode)) {
                connection.close(1008, "valid committed room code required");
                return;
            }
            register(
                connection,
                new Channel(ChannelKind.BOARD, roomCode, null, false)
            );
            System.out.println(
                "[platform-ws] board connected room=" + roomCode
                    + ": " + connection.getRemoteSocketAddress()
            );
            return;
        }

        String drawingCode = normalizeCode(query.get("drawingCode"));
        if (
            drawingCode != null
            && drawingSync != null
            && drawingSync.isActive(drawingCode)
        ) {
            String drawerToken = query.get("drawerToken");
            boolean canWrite = drawerToken != null
                && drawingSync.isAuthorizedDrawer(
                    drawingCode,
                    drawerToken
                );

            if (drawerToken != null && !canWrite) {
                connection.close(1008, "invalid drawer token");
                return;
            }

            register(
                connection,
                new Channel(
                    ChannelKind.DRAWING,
                    drawingCode,
                    drawerToken,
                    canWrite
                )
            );

            for (String event : drawingSync.history(drawingCode)) {
                if (!connection.isOpen()) break;
                connection.send(event);
            }

            System.out.println(
                "[platform-ws] drawing connected code=" + drawingCode
                    + " role=" + (canWrite ? "drawer" : "overlay")
                    + ": " + connection.getRemoteSocketAddress()
            );
            return;
        }

        connection.close(1008, "valid board room or drawing code required");
    }

    private void register(WebSocket connection, Channel channel) {
        channelByConnection.put(connection, channel);
        connectedClients.incrementAndGet();
    }

    @Override
    public void onClose(
        WebSocket connection,
        int code,
        String reason,
        boolean remote
    ) {
        Channel channel = channelByConnection.remove(connection);
        int count = connectedClients.get();
        if (channel != null) {
            count = Math.max(0, connectedClients.decrementAndGet());
        }
        System.out.println(
            "[platform-ws] disconnected"
                + (channel == null
                    ? ""
                    : " " + channel.kind().name().toLowerCase(Locale.ROOT)
                        + "=" + channel.code())
                + " (" + count + ")"
        );
    }

    @Override
    public void onMessage(WebSocket connection, String message) {
        if ("ping".equalsIgnoreCase(message.trim())) {
            connection.send("pong");
            return;
        }

        Channel channel = channelByConnection.get(connection);
        if (channel == null) {
            connection.close(1008, "unregistered connection");
            return;
        }

        if (channel.kind() == ChannelKind.BOARD) {
            return;
        }

        if (!channel.canWrite()) {
            connection.close(1008, "drawing overlay is read-only");
            return;
        }

        try {
            String canonical = drawingSync.append(
                channel.code(),
                channel.drawerToken(),
                message
            );
            broadcastDrawing(channel.code(), canonical);
        } catch (SecurityException error) {
            connection.close(1008, "drawing write authorization failed");
        } catch (Exception error) {
            connection.send(
                "{\"type\":\"drawing.error\",\"message\":"
                    + jsonString(error.getMessage())
                    + "}"
            );
        }
    }

    @Override
    public void onError(WebSocket connection, Exception error) {
        System.err.println("[platform-ws] " + error.getMessage());
    }

    @Override
    public void onStart() {
        System.out.println(
            "[platform-ws] listening on ws://"
                + getAddress().getHostString()
                + ":" + getPort()
        );
    }

    public int connectedClients() {
        return connectedClients.get();
    }

    public boolean broadcastEvent(String roomId, String json) {
        String normalizedRoomId = normalizeCode(roomId);
        if (normalizedRoomId == null) return false;

        boolean sent = false;
        for (var entry : channelByConnection.entrySet()) {
            Channel channel = entry.getValue();
            if (
                channel.kind() != ChannelKind.BOARD
                || !normalizedRoomId.equals(channel.code())
            ) {
                continue;
            }
            WebSocket connection = entry.getKey();
            if (!connection.isOpen()) continue;
            connection.send(json);
            sent = true;
        }
        return sent;
    }

    @Deprecated
    public boolean broadcastEvent(String json) {
        boolean sent = false;
        for (var entry : channelByConnection.entrySet()) {
            if (entry.getValue().kind() != ChannelKind.BOARD) continue;
            WebSocket connection = entry.getKey();
            if (!connection.isOpen()) continue;
            connection.send(json);
            sent = true;
        }
        return sent;
    }

    private boolean broadcastDrawing(String drawingCode, String json) {
        boolean sent = false;
        for (var entry : channelByConnection.entrySet()) {
            Channel channel = entry.getValue();
            if (
                channel.kind() != ChannelKind.DRAWING
                || !drawingCode.equals(channel.code())
            ) {
                continue;
            }
            WebSocket connection = entry.getKey();
            if (!connection.isOpen()) continue;
            connection.send(json);
            sent = true;
        }
        return sent;
    }

    private static Map<String, String> queryParameters(
        ClientHandshake handshake
    ) {
        if (handshake == null) return Map.of();

        String resource = handshake.getResourceDescriptor();
        if (resource == null) return Map.of();

        int queryIndex = resource.indexOf('?');
        if (queryIndex < 0 || queryIndex >= resource.length() - 1) {
            return Map.of();
        }

        var result = new java.util.LinkedHashMap<String, String>();
        String query = resource.substring(queryIndex + 1);
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            if (equals <= 0) continue;

            String name = URLDecoder.decode(
                pair.substring(0, equals),
                StandardCharsets.UTF_8
            );
            String value = URLDecoder.decode(
                pair.substring(equals + 1),
                StandardCharsets.UTF_8
            );
            result.put(name, value);
        }
        return result;
    }

    private static String normalizeCode(String value) {
        if (value == null) return null;
        String normalized = value.trim().toUpperCase(Locale.ROOT);
        return CODE_PATTERN.matcher(normalized).matches()
            ? normalized
            : null;
    }

    private static String jsonString(String value) {
        if (value == null) return "\"\"";
        String escaped = value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", "\\r")
            .replace("\n", "\\n");
        return "\"" + escaped + "\"";
    }
}
