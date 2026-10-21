package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import com.google.gson.Gson;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService.Forbidden;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.MemberStatus;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiConsumer;

/**
 * Durable member-only chat and a monotonic room event log. Neither the
 * Drawing guess input nor any Yacht game command is processed here.
 * The transport callback runs only AFTER SQLite COMMIT.
 */
public final class GameRoomRealtimeService {
    private static final Gson JSON = new Gson();
    private static final int MAX_MESSAGE_LENGTH = 500;
    private static final int PAGE_SIZE = 100;
    private static final int MAX_EVENT_HISTORY = 4000;
    private static final long RATE_WINDOW_NANOS = 1_000_000_000L;
    private final DatabaseAccess database;
    private final GameRoomService rooms;
    private final GameRoomAccessService access;
    private final Clock clock;
    private final BiConsumer<String, String> broadcast;
    private final ConcurrentHashMap<String, Rate> memberRates = new ConcurrentHashMap<>();

    /** Immutable canonical event: sequence scoped to one room, never a game. */
    public record Event(String type, String roomId, long sequence,
                        String memberId, String messageId, String displayName,
                        String text, String createdAt) {}
    private record WriteResult(Event event,boolean created) {}
    public record Page(long cursor, long firstAvailable, List<Event> events) {}
    public record ChatMessage(long sequence, String messageId, String memberId,
                              String displayName, String text, String createdAt,
                              boolean deleted) {}
    public record ChatPage(long next, List<ChatMessage> messages) {}

    private static final class Rate {
        long started = System.nanoTime();
        int count;
        synchronized boolean allow() {
            long now = System.nanoTime();
            if (now - started >= RATE_WINDOW_NANOS) {
                started = now;
                count = 0;
            }
            return ++count <= 5;
        }
    }

    public GameRoomRealtimeService(DatabaseAccess database,
                                   GameRoomAccessService access,
                                   BiConsumer<String, String> broadcast) {
        this(database, access, broadcast, Clock.systemUTC());
    }
    public GameRoomRealtimeService(DatabaseAccess database,
                                   GameRoomAccessService access,
                                   BiConsumer<String, String> broadcast,
                                   Clock clock) {
        this.database = Objects.requireNonNull(database);
        this.rooms = new GameRoomService(database, clock);
        this.access = Objects.requireNonNull(access);
        this.broadcast = Objects.requireNonNull(broadcast);
        this.clock = Objects.requireNonNull(clock);
    }

    public Event chat(String token, String messageId, String text) throws SQLException {
        if (messageId == null || !messageId.matches("[A-Za-z0-9_-]{8,64}")) {
            throw new IllegalArgumentException("invalid chat messageId");
        }
        if (text == null || text.isBlank() || text.length() > MAX_MESSAGE_LENGTH
            || text.indexOf('\u0000') >= 0) {
            throw new IllegalArgumentException("invalid chat length or content");
        }
        String trimmed = text.strip();
        if (trimmed.isEmpty()) throw new IllegalArgumentException("blank message");
        WriteResult write = rooms.write(connection -> {
            var self = access.requireSession(connection, token);
            requireConnected(connection, self.roomId(), self.memberId());
            try (var lookup = connection.prepareStatement("""
                SELECT c.sequence,c.member_id,c.body,c.created_at,
                       m.display_name,c.deleted_at
                FROM game_room_chat c
                JOIN game_room_member m ON m.member_id=c.member_id
                WHERE c.room_id=? AND c.message_id=?
                """)) {
                lookup.setString(1, self.roomId());
                lookup.setString(2, messageId);
                try (var previous = lookup.executeQuery()) {
                    if (previous.next()) {
                        if (!self.memberId().equals(previous.getString(2))
                            || !trimmed.equals(previous.getString(3))
                            || previous.getString(6) != null) {
                            throw new GameRoomService.RoomConflict(
                                "message ID already used for another message");
                        }
                        return new WriteResult(
                            new Event("room.chat.message",self.roomId(),
                                previous.getLong(1),self.memberId(),messageId,
                                previous.getString(5),trimmed,previous.getString(4)),
                            false);
                    }
                }
            }
            // Idempotent retries must not consume the sender's chat quota.
            String rateKey = self.roomId() + ":" + self.memberId();
            if (!memberRates.computeIfAbsent(rateKey,key -> new Rate()).allow()) {
                throw new GameRoomService.RoomConflict("chat rate exceeded");
            }
            long sequence = nextSequence(connection, self.roomId());
            String now = clock.instant().toString();
            String displayName = getName(connection, self.memberId());
            try (var insert = connection.prepareStatement("""
                INSERT INTO game_room_chat(room_id,sequence,message_id,member_id,
                                           body,created_at,deleted_at)
                VALUES(?,?,?,?,?,?,NULL)
                """)) {
                insert.setString(1,self.roomId());
                insert.setLong(2,sequence);
                insert.setString(3,messageId);
                insert.setString(4,self.memberId());
                insert.setString(5,trimmed);
                insert.setString(6,now);
                insert.executeUpdate();
            }
            Event committed = new Event("room.chat.message",self.roomId(),sequence,
                self.memberId(),messageId,displayName,trimmed,now);
            persistEvent(connection,committed);
            pruneHistory(connection,self.roomId(),sequence);
            return new WriteResult(committed,true);
        });
        // Only first commit produces a live broadcast; identical retries
        // return the original event without disturbing subscribers.
        if (write.created()) publish(write.event());
        return write.event();
    }

    public Event delete(String token, String messageId) throws SQLException {
        if (messageId == null || !messageId.matches("[A-Za-z0-9_-]{8,64}")) {
            throw new IllegalArgumentException("invalid message ID");
        }
        Event event = rooms.write(connection -> {
            var principal = access.requireSession(connection,token);
            requireConnected(connection, principal.roomId(), principal.memberId());
            String author;
            String displayName;
            String deletedAt;
            String originalCreatedAt;
            long originalSequence;
            try (var lookup = connection.prepareStatement("""
                SELECT c.member_id,m.display_name,c.deleted_at,c.sequence,c.created_at
                FROM game_room_chat c JOIN game_room_member m
                ON m.member_id=c.member_id
                WHERE c.room_id=? AND c.message_id=?
                """)) {
                lookup.setString(1,principal.roomId());
                lookup.setString(2,messageId);
                try (var result=lookup.executeQuery()) {
                    if (!result.next()) throw new java.util.NoSuchElementException("message not found");
                    author=result.getString(1);
                    displayName=result.getString(2);
                    deletedAt=result.getString(3);
                    originalSequence=result.getLong(4);
                    originalCreatedAt=result.getString(5);
                }
            }
            if (!principal.isHost() && !principal.memberId().equals(author)) {
                throw new Forbidden("message moderation denied");
            }
            if (deletedAt != null) {
                throw new GameRoomService.RoomConflict("already deleted");
            }
            String now=clock.instant().toString();
            try(var update=connection.prepareStatement("""
                UPDATE game_room_chat SET body='',deleted_at=?
                WHERE room_id=? AND message_id=? AND deleted_at IS NULL
                """)) {
                update.setString(1,now);
                update.setString(2,principal.roomId());
                update.setString(3,messageId);
                if(update.executeUpdate()!=1)throw new GameRoomService.RoomConflict("delete raced");
            }
            // Do not expose a deleted message through a historical event replay.
            // Preserve the old sequence, but redact its original payload.
            Event redacted=new Event("room.chat.message",principal.roomId(),
                originalSequence,author,messageId,displayName,null,originalCreatedAt);
            try(var update=connection.prepareStatement("""
                UPDATE game_room_event SET payload=? WHERE room_id=? AND sequence=?
                """)) {
                update.setString(1,JSON.toJson(redacted));
                update.setString(2,principal.roomId());
                update.setLong(3,originalSequence);
                // The original event may have passed bounded retention,
                // but the persisted chat can still be moderated.
                if(update.executeUpdate()!=1
                    && originalSequence >= Math.max(1,
                        lastSequence(connection,principal.roomId())-MAX_EVENT_HISTORY+1)) {
                    throw new IllegalStateException("original chat event unavailable");
                }
            }
            long seq=nextSequence(connection,principal.roomId());
            Event committed=new Event("room.chat.deleted",principal.roomId(),
                seq,author,messageId,displayName,null,now);
            persistEvent(connection,committed);
            pruneHistory(connection,principal.roomId(),seq);
            return committed;
        });
        publish(event);
        return event;
    }

    /** Events after a durable, per-room cursor; bounded to 100 per page. */
    public Page events(String token,long after) throws SQLException {
        if(after < -1)throw new IllegalArgumentException("invalid replay cursor");
        try(var connection=database.open()){
            var principal=access.requireSession(connection,token);
            long last=lastSequence(connection,principal.roomId());
            long first=Math.max(1,last-MAX_EVENT_HISTORY+1);
            if(after >= 0 && after < first-1){
                throw new GameRoomService.RoomConflict("event cursor expired: reload snapshot");
            }
            var out=new ArrayList<Event>();
            try(var stmt=connection.prepareStatement("""
                SELECT payload FROM game_room_event
                WHERE room_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?
                """)){
                stmt.setString(1,principal.roomId());
                stmt.setLong(2,after);
                stmt.setInt(3,PAGE_SIZE);
                try(var rows=stmt.executeQuery()){
                    while(rows.next())out.add(JSON.fromJson(rows.getString(1),Event.class));
                }
            }
            long cursor=out.isEmpty()?Math.min(last,Math.max(0,after))
                :out.getLast().sequence();
            return new Page(cursor,first,List.copyOf(out));
        }
    }

    /** Last committed event sequence from a DB-backed room projection. */
    public long lastSequence(String token) throws SQLException {
        try(var connection=database.open()){
            var principal=access.requireSession(connection,token);
            return lastSequence(connection,principal.roomId());
        }
    }

    public ChatPage recentChat(String token,long after) throws SQLException {
        if(after < -1)throw new IllegalArgumentException("invalid chat cursor");
        try(var connection=database.open()){
            var principal=access.requireSession(connection,token);
            var out=new ArrayList<ChatMessage>();
            try(var stmt=connection.prepareStatement("""
                SELECT c.sequence,c.message_id,c.member_id,m.display_name,
                       c.body,c.created_at,c.deleted_at
                FROM game_room_chat c JOIN game_room_member m
                   ON m.member_id=c.member_id
                WHERE c.room_id=? AND c.sequence>?
                ORDER BY c.sequence ASC LIMIT ?
                """)){
                stmt.setString(1,principal.roomId());
                stmt.setLong(2,after);
                stmt.setInt(3,PAGE_SIZE);
                try(var rows=stmt.executeQuery()){
                    while(rows.next())out.add(new ChatMessage(
                        rows.getLong(1),rows.getString(2),rows.getString(3),
                        rows.getString(4),rows.getString(7)==null?rows.getString(5):null,
                        rows.getString(6),rows.getString(7)!=null));
                }
            }
            long cursor=out.isEmpty()?after:out.getLast().sequence();
            return new ChatPage(cursor,List.copyOf(out));
        }
    }

    private static void requireConnected(Connection connection,String roomId,
                                         String memberId) throws SQLException {
        try(var stmt=connection.prepareStatement("""
            SELECT membership_status FROM game_room_member
            WHERE room_id=? AND member_id=?
            """)){
            stmt.setString(1,roomId);stmt.setString(2,memberId);
            try(var rows=stmt.executeQuery()){
                if(!rows.next() || !MemberStatus.JOINED.name().equals(rows.getString(1))){
                    throw new Forbidden("only connected room members can chat");
                }
            }
        }
    }

    private static String getName(Connection connection,String memberId)
        throws SQLException {
        try(var stmt=connection.prepareStatement(
            "SELECT display_name FROM game_room_member WHERE member_id=?")){
            stmt.setString(1,memberId);
            try(var rows=stmt.executeQuery()){
                if(!rows.next())throw new Forbidden("member not found");
                return rows.getString(1);
            }
        }
    }

    private static long lastSequence(Connection connection,String roomId)
        throws SQLException {
        try(var stmt=connection.prepareStatement(
            "SELECT event_sequence FROM game_room WHERE room_id=?")){
            stmt.setString(1,roomId);
            try(var rows=stmt.executeQuery()){
                if(!rows.next())throw new java.util.NoSuchElementException("room not found");
                return rows.getLong(1);
            }
        }
    }

    private static long nextSequence(Connection connection,String roomId)
        throws SQLException {
        try(var stmt=connection.prepareStatement("""
            UPDATE game_room SET event_sequence=event_sequence+1 WHERE room_id=?
            """)){
            stmt.setString(1,roomId);
            if(stmt.executeUpdate()!=1)throw new java.util.NoSuchElementException("room not found");
        }
        return lastSequence(connection,roomId);
    }

    private static void persistEvent(Connection connection,Event event)
        throws SQLException {
        try(var stmt=connection.prepareStatement("""
            INSERT INTO game_room_event(room_id,sequence,event_type,payload,created_at)
            VALUES(?,?,?,?,?)
            """)){
            stmt.setString(1,event.roomId());
            stmt.setLong(2,event.sequence());
            stmt.setString(3,event.type());
            stmt.setString(4,JSON.toJson(event));
            stmt.setString(5,event.createdAt());
            stmt.executeUpdate();
        }
    }

    private static void pruneHistory(Connection connection,String roomId,long sequence)
        throws SQLException {
        if(sequence <= MAX_EVENT_HISTORY)return;
        try(var stmt=connection.prepareStatement("""
            DELETE FROM game_room_event WHERE room_id=? AND sequence<=?
            """)){
            stmt.setString(1,roomId);
            stmt.setLong(2,sequence-MAX_EVENT_HISTORY);
            stmt.executeUpdate();
        }
    }

    private void publish(Event event) {
        try { broadcast.accept(event.roomId(),JSON.toJson(event)); }
        catch (RuntimeException ignored) {
            // durable event is replayable after a lost websocket delivery
        }
    }
}
