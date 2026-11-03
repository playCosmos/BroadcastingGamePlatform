package io.github.playcosmos.broadcastinggameplatform.boardserver;

import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomRealtimeService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomService;
import com.google.gson.Gson;
import com.google.gson.JsonParser;
import java.sql.SQLException;
import java.util.UUID;
import java.net.InetSocketAddress;
import java.util.LinkedHashMap;
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
    private static final Gson JSON = new Gson();
    private static final Pattern ROOM_ID_PATTERN = Pattern.compile(
        "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}");
    private static final Pattern CODE_PATTERN =
        Pattern.compile("[A-HJ-NP-Z2-9]{6}");
    private static final int MAX_TOTAL_CONNECTIONS = 256;
    private static final int MAX_CONNECTIONS_PER_REMOTE_ADDRESS = 24;
    private static final int MAX_BOARD_CONNECTIONS_PER_ROOM = 32;
    private static final int MAX_DRAWING_CONNECTIONS_PER_CODE = 24;
    private static final int MAX_DRAWER_CONNECTIONS_PER_CODE = 2;
    private static final int MAX_DRAWING_MESSAGES_PER_SECOND = 60;
    private static final int MAX_INBOUND_MESSAGE_CHARS = 8 * 1024;
    private static final long DRAWING_RATE_WINDOW_NANOS =
        1_000_000_000L;
    private static final int MAX_RESOURCE_DESCRIPTOR_CHARS = 4096;
    private static final int MAX_HANDSHAKES_PER_WINDOW = 120;
    private static final int MAX_HANDSHAKE_RATE_KEYS = 4096;
    private static final long HANDSHAKE_RATE_WINDOW_NANOS =
        10_000_000_000L;

    private enum ChannelKind {
        BOARD,
        DRAWING,
        YACHT,
        MEMBER_ROOM
    }

    private record Channel(
        ChannelKind kind,
        String code,
        String drawerToken,
        boolean canWrite
    ) {}

    static final class HandshakeRateWindow {
        private long startedAtNanos;
        private int count;

        boolean allow(long nowNanos) {
            if (
                startedAtNanos == 0
                    || nowNanos - startedAtNanos
                        >= HANDSHAKE_RATE_WINDOW_NANOS
            ) {
                startedAtNanos = nowNanos;
                count = 0;
            }
            count += 1;
            return count <= MAX_HANDSHAKES_PER_WINDOW;
        }

        boolean expired(long nowNanos) {
            return startedAtNanos != 0
                && nowNanos - startedAtNanos
                    >= HANDSHAKE_RATE_WINDOW_NANOS;
        }
    }

    private static final class MessageRateWindow {
        private long startedAtNanos = System.nanoTime();
        private int count;

        synchronized boolean allow() {
            long now = System.nanoTime();
            if (
                now - startedAtNanos
                    >= DRAWING_RATE_WINDOW_NANOS
            ) {
                startedAtNanos = now;
                count = 0;
            }
            count += 1;
            return count <= MAX_DRAWING_MESSAGES_PER_SECOND;
        }
    }

    private final AtomicInteger connectedClients = new AtomicInteger();
    private final Map<WebSocket, Channel> channelByConnection =
        new ConcurrentHashMap<>();
    private final Map<WebSocket, MessageRateWindow> drawingWriteRates =
        new ConcurrentHashMap<>();
    private final LinkedHashMap<String, HandshakeRateWindow>
        handshakeRates = new LinkedHashMap<>();
    private final Predicate<String> roomCodeValidator;
    private final DrawingSyncService drawingSync;
    private final Predicate<String> yachtCodeValidator;
    private final GameRoomAccessService membership;
    private final GameRoomRealtimeService realtime;
    private final Object memberSendLock = new Object();
    private record Subscriber(String roomId,String memberId,String token) {}
    private final Map<WebSocket, Subscriber> roomSubscribers =
        new ConcurrentHashMap<>();

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
        this(host, port, roomCodeValidator, drawingSync, code -> false);
    }

    public BoardGameWebSocketServer(
        String host, int port, Predicate<String> roomCodeValidator,
        DrawingSyncService drawingSync, Predicate<String> yachtCodeValidator
    ) {
        this(host,port,roomCodeValidator,drawingSync,yachtCodeValidator,null,null);
    }

    public BoardGameWebSocketServer(
        String host, int port, Predicate<String> roomCodeValidator,
        DrawingSyncService drawingSync, Predicate<String> yachtCodeValidator,
        GameRoomAccessService membership, GameRoomRealtimeService realtime
    ) {
        super(new InetSocketAddress(host, port));
        this.membership=membership;
        this.realtime=realtime;
        this.yachtCodeValidator = yachtCodeValidator == null
            ? code -> false : yachtCodeValidator;
        this.roomCodeValidator = roomCodeValidator == null
            ? roomCode -> false
            : roomCodeValidator;
        this.drawingSync = drawingSync;
        setReuseAddr(true);
    }

    @Override
    public void onOpen(WebSocket connection, ClientHandshake handshake) {
        if (!allowHandshake(connection, handshake)) {
            connection.close(1013, "websocket handshake rate exceeded");
            return;
        }

        Map<String, String> query = queryParameters(handshake);
        String memberRoomId = query.get("memberRoomId");
        if (memberRoomId != null) {
            if (membership == null || realtime == null
                || !ROOM_ID_PATTERN.matcher(memberRoomId).matches()) {
                connection.close(1008,"invalid member room");
                return;
            }
            if (!registerIfCapacity(connection,
                new Channel(ChannelKind.MEMBER_ROOM, memberRoomId, null, false))) {
                connection.close(1013,"room websocket capacity reached");
            }
            // Socket remains unprivileged until a valid room.subscribe frame.
            // Never place bearer secrets in URL/query params or server logs.
            return;
        }
        String roomCode = normalizeCode(query.get("roomCode"));
        if (roomCode != null) {
            if (!roomCodeValidator.test(roomCode)) {
                connection.close(1008, "valid committed room code required");
                return;
            }
            if (!registerIfCapacity(
                connection,
                new Channel(ChannelKind.BOARD, roomCode, null, false)
            )) {
                connection.close(1013, "room connection capacity reached");
                return;
            }
            System.out.println(
                "[platform-ws] board connected"
                    + " connections=" + connectedClients.get()
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

            if (!registerIfCapacity(
                connection,
                new Channel(
                    ChannelKind.DRAWING,
                    drawingCode,
                    drawerToken,
                    canWrite
                )
            )) {
                connection.close(1013, "drawing connection capacity reached");
                return;
            }

            for (String event : drawingSync.history(drawingCode)) {
                if (!connection.isOpen()) break;
                connection.send(event);
            }

            System.out.println(
                "[platform-ws] drawing connected role="
                    + (canWrite ? "drawer" : "overlay")
                    + " connections=" + connectedClients.get()
            );
            return;
        }

        String yachtCode = normalizeCode(query.get("yachtCode"));
        if (yachtCode != null && yachtCodeValidator.test(yachtCode)) {
            if (!registerIfCapacity(connection,
                new Channel(ChannelKind.YACHT, yachtCode, null, false))) {
                connection.close(1013, "Yacht channel at capacity");
                return;
            }
            return;
        }
        connection.close(1008, "valid board, Yacht or drawing code required");
    }

    private synchronized boolean allowHandshake(
        WebSocket connection,
        ClientHandshake handshake
    ) {
        long nowNanos = System.nanoTime();
        handshakeRates.entrySet().removeIf(
            entry -> entry.getValue().expired(nowNanos)
        );

        InetSocketAddress remote = connection.getRemoteSocketAddress();
        String forwardedFor = null;
        if (GameClientHttpServer.isTrustedForwardProxy(remote)) {
            String header = handshake.getFieldValue("X-Forwarded-For");
            if (header != null && !header.isBlank()) {
                forwardedFor = header;
            }
        }
        String key = GameClientHttpServer.rateLimitAddressKey(
            remote,
            forwardedFor
        );

        if (
            !handshakeRates.containsKey(key)
                && handshakeRates.size() >= MAX_HANDSHAKE_RATE_KEYS
        ) {
            var iterator = handshakeRates.entrySet().iterator();
            if (iterator.hasNext()) {
                iterator.next();
                iterator.remove();
            }
        }

        HandshakeRateWindow window = handshakeRates.computeIfAbsent(
            key,
            ignored -> new HandshakeRateWindow()
        );
        return window.allow(nowNanos);
    }

    private synchronized boolean registerIfCapacity(
        WebSocket connection,
        Channel channel
    ) {
        if (connectedClients.get() >= MAX_TOTAL_CONNECTIONS) {
            return false;
        }

        int remoteConnections = 0;
        var remoteAddress = connection.getRemoteSocketAddress();
        for (WebSocket activeConnection : channelByConnection.keySet()) {
            if (
                sameRemoteAddress(
                    remoteAddress,
                    activeConnection.getRemoteSocketAddress()
                )
            ) {
                remoteConnections += 1;
            }
        }
        if (
            remoteConnections
                >= MAX_CONNECTIONS_PER_REMOTE_ADDRESS
        ) {
            return false;
        }

        int channelConnections = 0;
        int drawerConnections = 0;
        for (Channel active : channelByConnection.values()) {
            if (
                active.kind() != channel.kind()
                || !active.code().equals(channel.code())
            ) {
                continue;
            }
            channelConnections += 1;
            if (active.kind() == ChannelKind.DRAWING && active.canWrite()) {
                drawerConnections += 1;
            }
        }

        if (
            (channel.kind() == ChannelKind.BOARD
                || channel.kind() == ChannelKind.YACHT
                || channel.kind() == ChannelKind.MEMBER_ROOM)
                && channelConnections >= MAX_BOARD_CONNECTIONS_PER_ROOM
        ) {
            return false;
        }
        if (
            channel.kind() == ChannelKind.DRAWING
                && channelConnections >= MAX_DRAWING_CONNECTIONS_PER_CODE
        ) {
            return false;
        }
        if (
            channel.kind() == ChannelKind.DRAWING
                && channel.canWrite()
                && drawerConnections >= MAX_DRAWER_CONNECTIONS_PER_CODE
        ) {
            return false;
        }

        channelByConnection.put(connection, channel);
        if (
            channel.kind() == ChannelKind.DRAWING
                && channel.canWrite()
        ) {
            drawingWriteRates.put(
                connection,
                new MessageRateWindow()
            );
        }
        connectedClients.incrementAndGet();
        return true;
    }

    private static boolean sameRemoteAddress(
        InetSocketAddress left,
        InetSocketAddress right
    ) {
        if (left == null || right == null) return false;
        if (left.getAddress() != null && right.getAddress() != null) {
            return left.getAddress().equals(right.getAddress());
        }
        return left.getHostString().equalsIgnoreCase(
            right.getHostString()
        );
    }

    @Override
    public void onClose(
        WebSocket connection,
        int code,
        String reason,
        boolean remote
    ) {
        Channel channel = channelByConnection.remove(connection);
        Subscriber subscriber = roomSubscribers.remove(connection);
        if (subscriber != null) publishPresence(subscriber.roomId(),subscriber.memberId());
        drawingWriteRates.remove(connection);
        int count = connectedClients.get();
        if (channel != null) {
            count = Math.max(0, connectedClients.decrementAndGet());
        }
        System.out.println(
            "[platform-ws] disconnected"
                + (channel == null
                    ? ""
                    : " " + channel.kind().name().toLowerCase(Locale.ROOT))
                + " (" + count + ")"
        );
    }

    @Override
    public void onMessage(WebSocket connection, String message) {
        if (
            message == null
                || message.length() > MAX_INBOUND_MESSAGE_CHARS
        ) {
            connection.close(1009, "websocket message too large");
            return;
        }

        if ("ping".equalsIgnoreCase(message.trim())) {
            connection.send("pong");
            return;
        }

        Channel channel = channelByConnection.get(connection);
        if (channel == null) {
            connection.close(1008, "unregistered connection");
            return;
        }

        if (channel.kind() == ChannelKind.MEMBER_ROOM) {
            memberRoomMessage(connection,channel,message);
            return;
        }
        if (channel.kind() == ChannelKind.BOARD) {
            return;
        }
        if (channel.kind() == ChannelKind.YACHT) {
            // Yacht mutations require authenticated HTTP; WebSocket clients
            // can only observe independently validated room-code channels.
            connection.close(1008, "Yacht WebSocket is read-only");
            return;
        }

        if (!channel.canWrite()) {
            connection.close(1008, "drawing overlay is read-only");
            return;
        }

        MessageRateWindow rate = drawingWriteRates.computeIfAbsent(
            connection,
            ignored -> new MessageRateWindow()
        );
        if (!rate.allow()) {
            connection.close(1008, "drawing write rate exceeded");
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

    /**
     * First member-room frame must be authenticated. The bearer secret is
     * never accepted in the URI; later frames cannot mutate room/game state.
     */
    private void memberRoomMessage(WebSocket connection,Channel channel,String message) {
        if (roomSubscribers.containsKey(connection)) {
            connection.close(1008,"room WebSocket is read-only");
            return;
        }
        try {
            var frame=JsonParser.parseString(message).getAsJsonObject();
            if (!frame.has("type") ||
                !"room.subscribe".equals(frame.get("type").getAsString()) ||
                !frame.has("token") || !frame.has("afterSequence")) {
                connection.close(1008,"room subscribe required");
                return;
            }
            String token=frame.get("token").getAsString();
            long after=frame.get("afterSequence").getAsLong();
            if(after < -1 || after > 999_999_999_999_999L) {
                connection.close(1008,"invalid room event cursor");
                return;
            }
            synchronized (memberSendLock) {
                var principal=membership.authenticate(token);
                if (!channel.code().equals(principal.roomId())
                    || membership.room(token).members().stream().noneMatch(m ->
                        m.memberId().equals(principal.memberId())
                        && m.status()==io.github.playcosmos.broadcastinggameplatform
                            .platform.rooms.GameRoomModels.MemberStatus.JOINED)) {
                    connection.close(1008,"room membership invalid");
                    return;
                }
                roomSubscribers.put(connection,
                    new Subscriber(principal.roomId(),principal.memberId(),token));
                var room=membership.room(token);
                connection.send(JSON.toJson(Map.of(
                    "type","room.snapshot",
                    "roomId",principal.roomId(),
                    "memberCount",room.memberCount(),
                    "playerCount",room.playerCount(),
                    "lastSequence",realtime.lastSequence(token))));
                var history=realtime.events(token,after);
                for (var event:history.events()) {
                    if (connection.isOpen())connection.send(JSON.toJson(event));
                }
                publishPresence(principal.roomId(),principal.memberId());
            }
        } catch (GameRoomAccessService.Forbidden | SQLException
                 | GameRoomService.RoomConflict invalid) {
            connection.close(1008,"room subscription unauthorized");
        } catch (RuntimeException malformed) {
            connection.close(1008,"room subscription invalid");
        }
    }

    /** Called after SQLite commit, serialized with subscription+replay. */
    public boolean broadcastRoomEvent(String roomId,String json) {
        boolean sent=false;
        synchronized(memberSendLock) {
            for(var entry:roomSubscribers.entrySet()) {
                Subscriber subscriber=entry.getValue();
                if(!subscriber.roomId().equals(roomId))continue;
                WebSocket socket=entry.getKey();
                if(!socket.isOpen())continue;
                try {
                    var principal=membership.authenticate(subscriber.token());
                    if(!principal.memberId().equals(subscriber.memberId())
                        || !principal.roomId().equals(roomId)) {
                        socket.close(1008,"member session changed");
                        continue;
                    }
                    socket.send(json);
                    sent=true;
                } catch (GameRoomAccessService.Forbidden | SQLException invalid) {
                    socket.close(1008,"room credential expired");
                }
            }
        }
        return sent;
    }

    private void publishPresence(String roomId,String memberId) {
        synchronized(memberSendLock) {
            long connections=roomSubscribers.values().stream().filter(s ->
                s.roomId().equals(roomId) && s.memberId().equals(memberId)).count();
            String json=JSON.toJson(Map.of("type","room.presence.changed",
                "roomId",roomId,"memberId",memberId,
                "connected",connections>0));
            broadcastRoomEvent(roomId,json);
        }
    }

    public boolean broadcastYacht(String roomCode, String json) {
        String normalized = normalizeCode(roomCode);
        if (normalized == null) return false;
        boolean sent = false;
        for (var entry : channelByConnection.entrySet()) {
            Channel channel = entry.getValue();
            if (channel.kind() != ChannelKind.YACHT
                || !normalized.equals(channel.code())) continue;
            WebSocket connection = entry.getKey();
            if (!connection.isOpen()) continue;
            connection.send(json);
            sent = true;
        }
        return sent;
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
        if (
            resource == null
                || resource.length() > MAX_RESOURCE_DESCRIPTOR_CHARS
        ) {
            return Map.of();
        }

        int queryIndex = resource.indexOf('?');
        if (queryIndex < 0 || queryIndex >= resource.length() - 1) {
            return Map.of();
        }

        var result = new java.util.LinkedHashMap<String, String>();
        String query = resource.substring(queryIndex + 1);
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            if (equals <= 0) continue;

            String name = GameClientHttpServer.safeQueryDecode(
                pair.substring(0, equals)
            );
            String value = GameClientHttpServer.safeQueryDecode(
                pair.substring(equals + 1)
            );
            if (name == null || value == null) continue;
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
