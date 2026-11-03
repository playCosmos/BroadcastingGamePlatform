package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.ClassicScorePolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChatMessageEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Member;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.MemberStatus;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Room;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.RoomState;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.ArrayList;
import java.util.NoSuchElementException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.NoSuchAlgorithmException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.time.Duration;
import java.util.function.Predicate;
import java.util.function.BiConsumer;

/**
 * R5 game-room adapter, separate from legacy streamer/admin Drawing Guess.
 * Authenticates each member command, freezes real PLAYER roster and routes
 * all scoring, round order and canvas history to the existing native engine.
 */
public final class GameRoomDrawingService {
    public record Snapshot(Room room, String memberId, DrawerPolicy mode,
        String nativeRoomId, DrawingGuessGameService.PublicRoomSnapshot game,
        boolean canDraw, String nextDrawerMemberId,
        int configuredRounds, int durationSeconds,boolean streamerRotation) {}
    public record CanvasEvent(String roundId,String json) {}
    public record Guess(String status,int rank,int guesserScore,int drawerScore) {}
    public record PrivatePrompt(String roundId,String answer,
                                List<String> acceptedAnswers) {}
    public record BroadcastChannel(String provider,String channelId) {}
    public record StreamerAssignment(String provider,String channelId,
                                     String memberId) {}
    public record ChannelGrant(String grant,String provider,String channelId,
                               String roomId,String expiresAt) {}
    /** Non-secret metadata for operator-only listing. */
    public record OperatorChannel(String provider,String channelId,
                                  String status,String changedAt) {}
    private static final SecureRandom GRANT_RANDOM=new SecureRandom();

    private final GameRoomService rooms;
    private final GameRoomTelephoneService telephone;

    public GameRoomTelephoneService telephone() { return telephone; }
    private final GameRoomAccessService access;
    private final DrawingGuessRepository repository;
    private final DrawingGuessGameService drawing;
    private final DrawingSyncService canvas;
    private final BiConsumer<String,String> broadcast;
    private final Predicate<BroadcastChannel> operatorSource;
    private static final Object START_LOCK=new Object();

    public GameRoomDrawingService(DatabaseAccess database,
        GameRoomAccessService access, DrawingGuessRepository repository,
        DrawingGuessGameService drawing,DrawingSyncService canvas,
        BiConsumer<String,String> broadcast) {
        this(database,access,repository,drawing,canvas,broadcast,
            source->false); // no implicit trust for old constructor
    }

    public GameRoomDrawingService(DatabaseAccess database,
        GameRoomAccessService access, DrawingGuessRepository repository,
        DrawingGuessGameService drawing,DrawingSyncService canvas,
        BiConsumer<String,String> broadcast,
        Predicate<BroadcastChannel> operatorSource) {
        this.operatorSource=Objects.requireNonNull(operatorSource);
        this.rooms=new GameRoomService(Objects.requireNonNull(database));
        this.telephone=new GameRoomTelephoneService(database,access);
        this.access=Objects.requireNonNull(access);
        this.repository=Objects.requireNonNull(repository);
        this.drawing=Objects.requireNonNull(drawing);
        this.canvas=Objects.requireNonNull(canvas);
        this.broadcast=broadcast==null?(code,json)->{}:broadcast;
    }

    public Snapshot state(String token)throws SQLException {
        var principal=access.authenticate(token);
        Room room=access.room(token);
        requireDrawing(room);
        Binding binding=binding(room.roomId());
        if(binding==null || binding.nativeRoomId()==null) {
            return new Snapshot(room,principal.memberId(),
                binding==null?null:binding.mode(),null,null,false,null,
                binding==null?0:binding.configuredRounds(),
                binding==null?0:binding.durationSeconds(),
                binding!=null && binding.streamerRotation());
        }
        var game=drawing.publicRoom(binding.nativeRoomId());
        return snapshot(room,principal.memberId(),binding,game);
    }

    /**
     * Server-host-only start, mode stored in an SQLite reservation in the
     * SAME transaction that freezes player seats. Interrupted startup can
     * resume with the source-room UNIQUE key without a second native room.
     */
    public Snapshot start(String hostToken,DrawerPolicy requested,
                          int rounds,int seconds)throws SQLException {
        return start(hostToken,requested,rounds,seconds,false);
    }

    public Snapshot start(String hostToken,DrawerPolicy requested,
                          int rounds,int seconds,boolean streamerRotation)
        throws SQLException {
        if(streamerRotation && requested!=DrawerPolicy.ROTATING_DRAWER)
            throw new IllegalArgumentException("streamer rotation requires rotating mode");
        if(requested==null)throw new IllegalArgumentException("mode required");
        if(rounds<1 || rounds>200 || seconds<10 || seconds>600)
            throw new IllegalArgumentException("invalid round configuration");
        var principal=access.authenticate(hostToken);
        if(!principal.isHost())
            throw new GameRoomAccessService.Forbidden("host required");
        synchronized(START_LOCK){
            var reservation=rooms.write(connection->{
                var caller=access.requireSession(connection,hostToken);
                Room room=GameRoomService.read(connection,caller.roomId());
                requireDrawing(room);
                if(!caller.isHost() ||
                    !caller.memberId().equals(principal.memberId()) ||
                    !connected(room,caller.memberId())) {
                    throw new GameRoomAccessService.Forbidden("connected host required");
                }
                if(room.state()!=RoomState.OPEN_LOBBY &&
                    room.state()!=RoomState.PLAYING) {
                    throw new GameRoomService.RoomConflict("room not ready for drawing");
                }
                List<Member> players=players(room);
                if(requested==DrawerPolicy.ROTATING_DRAWER && players.size()<2)
                    throw new GameRoomService.RoomConflict("rotating needs two players");
                if(requested==DrawerPolicy.STREAMER_DRAWER &&
                    players.stream().noneMatch(m->m.memberId().equals(caller.memberId())))
                    throw new GameRoomService.RoomConflict("streamer host must play");
                if(room.state()==RoomState.OPEN_LOBBY) {
                    if(players.isEmpty() || players.stream().anyMatch(m->
                        m.status()!=MemberStatus.JOINED || !m.ready()))
                        throw new GameRoomService.RoomConflict("all players must ready");
                }
                // Freeze trusted membership IDs in the reservation transaction,
                // not the mutable provider/channel mapping after match startup.
                List<String> selected=new ArrayList<>();
                if(streamerRotation && room.state()==RoomState.OPEN_LOBBY) {
                    var assigned=new java.util.HashSet<String>();
                    try(var stmt=connection.prepareStatement("""
                        SELECT drawer_member_id
                        FROM game_room_drawing_broadcast_binding
                        WHERE room_id=? AND authorized_at IS NOT NULL
                          AND drawer_member_id IS NOT NULL
                        """)) {
                        stmt.setString(1,room.roomId());
                        try(var rows=stmt.executeQuery()){
                            while(rows.next())assigned.add(rows.getString(1));
                        }
                    }
                    for(Member player:players)
                        if(assigned.contains(player.memberId()))selected.add(player.memberId());
                    if(selected.size()<2 || !assigned.equals(new java.util.HashSet<>(selected)))
                        throw new GameRoomService.RoomConflict(
                            "at least two connected, authorized streamer players required");
                }
                DrawerPolicy committed=requested;
                try(var lookup=connection.prepareStatement("""
                    SELECT drawer_policy,configured_rounds,duration_seconds,streamer_rotation
                    FROM game_room_drawing_link WHERE room_id=?
                    """)) {
                    lookup.setString(1,room.roomId());
                    try(var rows=lookup.executeQuery()) {
                        if(rows.next()) {
                            committed=DrawerPolicy.valueOf(rows.getString(1));
                            if(committed!=requested || rows.getInt(2)!=rounds
                                || rows.getInt(3)!=seconds
                                || (rows.getInt(4)==1)!=streamerRotation)
                                throw new GameRoomService.RoomConflict(
                                    "match configuration already frozen");
                        } else {
                            try(var insert=connection.prepareStatement("""
                                INSERT INTO game_room_drawing_link(
                                  room_id,drawing_room_id,match_id,drawer_policy,
                                  configured_rounds,duration_seconds,created_at,
                                  streamer_rotation
                                ) VALUES (?,NULL,NULL,?,?,?,?,?)
                                """)){
                                insert.setString(1,room.roomId());
                                insert.setString(2,requested.name());
                                insert.setInt(3,rounds);
                                insert.setInt(4,seconds);
                                insert.setString(5,Instant.now().toString());
                                insert.setInt(6,streamerRotation?1:0);
                                insert.executeUpdate();
                            }
                            if(streamerRotation) {
                                int index=0;
                                for(String memberId:selected) {
                                    try(var freeze=connection.prepareStatement("""
                                        INSERT INTO game_room_drawing_drawer_roster(
                                          room_id,drawer_order,member_id)
                                        VALUES(?,?,?)
                                        """)) {
                                        freeze.setString(1,room.roomId());
                                        freeze.setInt(2,index++);
                                        freeze.setString(3,memberId);
                                        freeze.executeUpdate();
                                    }
                                }
                            }
                        }
                    }
                }
                if(room.state()==RoomState.OPEN_LOBBY) {
                    try(var update=connection.prepareStatement("""
                        UPDATE game_room SET state='PLAYING'
                        WHERE room_id=? AND version=?
                        """)) {
                        update.setString(1,room.roomId());
                        update.setLong(2,room.version());
                        if(update.executeUpdate()!=1)
                            throw new GameRoomService.RoomConflict("stale room");
                    }
                    rooms.bump(connection,room);
                }
                return new Reservation(room,committed,rounds,seconds,
                    caller.memberId(),streamerRotation);
            });
            // Reuse deterministic native creation identity after any partial
            // process crash; never trust supplied roster IDs from the client.
            var nativeRoom=repository.findRoomBySourceRoom(reservation.room().roomId());
            if(nativeRoom==null){
                var roster=new ArrayList<DrawingGuessRepository.ParticipantInput>();
                var selected=reservation.streamerRotation()
                    ?new java.util.HashSet<>(frozenDrawerIds(reservation.room().roomId()))
                    :java.util.Set.<String>of();
                for(Member member:players(reservation.room())) {
                    roster.add(new DrawingGuessRepository.ParticipantInput(
                        member.memberId(),"GAMECENTER",member.memberId(),
                        member.displayName(),!reservation.streamerRotation()
                            || selected.contains(member.memberId())));
                }
                try {
                    nativeRoom=repository.createRoom(
                        reservation.room().roomName(),reservation.mode(),
                        reservation.mode()==DrawerPolicy.STREAMER_DRAWER
                            ?reservation.hostId():null,
                        ClassicScorePolicy.Config.defaults(),
                        reservation.seconds(),true,
                        "GAMECENTER",reservation.room().roomId(),
                        roster,reservation.room().roomId());
                }catch(SQLException raced){
                    nativeRoom=repository.findRoomBySourceRoom(
                        reservation.room().roomId());
                    if(nativeRoom==null)throw raced;
                }
            }
            if("DRAFT".equals(nativeRoom.state())) {
                try{nativeRoom=drawing.markReady(nativeRoom.roomId());}
                catch(IllegalStateException error) {
                    nativeRoom=repository.findRoom(nativeRoom.roomId());
                    if("DRAFT".equals(nativeRoom.state()))throw error;
                }
            }
            var match=repository.findActiveMatchByRoom(nativeRoom.roomId());
            if(match==null && "READY".equals(nativeRoom.state())) {
                try{match=drawing.startMatch(nativeRoom.roomId(),rounds);}
                catch(IllegalStateException failed) {
                    match=repository.findActiveMatchByRoom(nativeRoom.roomId());
                    if(match==null)throw failed;
                }
            }
            if(match==null)
                throw new GameRoomService.RoomConflict("Drawing match unavailable");
            final String nativeId=nativeRoom.roomId(),matchId=match.matchId();
            rooms.write(connection->{
                try(var update=connection.prepareStatement("""
                    UPDATE game_room_drawing_link
                    SET drawing_room_id=?,match_id=?
                    WHERE room_id=? AND
                      (drawing_room_id IS NULL OR drawing_room_id=?)
                    """)){
                    update.setString(1,nativeId);
                    update.setString(2,matchId);
                    update.setString(3,reservation.room().roomId());
                    update.setString(4,nativeId);
                    if(update.executeUpdate()!=1)
                        throw new GameRoomService.RoomConflict("Drawing binding mismatch");
                }
                return null;
            });
        }
        return state(hostToken);
    }

    /**
     * Explicit incoming broadcast channels; listing is member-scoped.
     * A binding never connects to a provider or grants access to a room.
     * Built-in GAMECENTER guesses retain their separate member-token path.
     */
    public List<BroadcastChannel> channels(String token) throws SQLException {
        Room room=access.room(token);
        requireDrawing(room);
        var result=new ArrayList<BroadcastChannel>();
        try(var connection=rooms.databaseForAccess().open();
            var statement=connection.prepareStatement("""
                SELECT provider,channel_id
                FROM game_room_drawing_broadcast_binding
                WHERE room_id=? AND authorized_at IS NOT NULL
                ORDER BY provider,channel_id
                """)) {
            statement.setString(1,room.roomId());
            try(var rows=statement.executeQuery()) {
                while(rows.next())result.add(new BroadcastChannel(
                    rows.getString(1),rows.getString(2)));
            }
        }
        return List.copyOf(result);
    }

    /**
     * Only the administrator API can call this; no grant hash or secret
     * leaves the database during a status listing.
     */
    public List<OperatorChannel> operatorChannels(String roomId)
        throws SQLException {
        requireDrawing(rooms.find(roomId));
        var result=new ArrayList<OperatorChannel>();
        try(var conn=rooms.databaseForAccess().open();
            var query=conn.prepareStatement("""
                SELECT provider,channel_id,'BOUND',authorized_at
                FROM game_room_drawing_broadcast_binding
                WHERE room_id=? AND authorized_at IS NOT NULL
                UNION ALL
                SELECT provider,channel_id,'PENDING',expires_at
                FROM game_room_drawing_broadcast_grant
                WHERE room_id=? AND consumed_at IS NULL
                  AND julianday(expires_at)>julianday(?)
                ORDER BY provider,channel_id
                """)) {
            query.setString(1,roomId);
            query.setString(2,roomId);
            query.setString(3,Instant.now().toString());
            try(var rows=query.executeQuery()) {
                while(rows.next())result.add(new OperatorChannel(
                    rows.getString(1),rows.getString(2),
                    rows.getString(3),rows.getString(4)));
            }
        }
        return List.copyOf(result);
    }

    /** Atomically withdraw both outstanding one-use grants and active routing. */
    public List<OperatorChannel> revokeOperatorChannel(
        String roomId,String provider,String channelId
    ) throws SQLException {
        String name=broadcastProvider(provider),channel=broadcastChannel(channelId);
        rooms.write(connection->{
            requireDrawing(GameRoomService.read(connection,roomId));
            try(var revoke=connection.prepareStatement("""
                DELETE FROM game_room_drawing_broadcast_grant
                WHERE room_id=? AND provider=? AND channel_id=?
                """)) {
                revoke.setString(1,roomId);
                revoke.setString(2,name);
                revoke.setString(3,channel);
                revoke.executeUpdate();
            }
            try(var unbind=connection.prepareStatement("""
                DELETE FROM game_room_drawing_broadcast_binding
                WHERE room_id=? AND provider=? AND channel_id=?
                """)) {
                unbind.setString(1,roomId);
                unbind.setString(2,name);
                unbind.setString(3,channel);
                unbind.executeUpdate();
            }
            return null;
        });
        return operatorChannels(roomId);
    }

    /**
     * The admin authentication check occurs at the HTTP boundary only.
     * Operator provisioning is an explicit grant, not broadcaster OAuth proof.
     * A grant is scoped to ONE room, provider, channel, and expiration.
     */
    public ChannelGrant issueChannelGrant(String roomId,String provider,
                                          String channelId,int ttlSeconds)
        throws SQLException {
        String name=broadcastProvider(provider),channel=broadcastChannel(channelId);
        if(ttlSeconds<60 || ttlSeconds>3600)
            throw new IllegalArgumentException("grant expiry must be 60..3600 seconds");
        if(!operatorSource.test(new BroadcastChannel(name,channel)))
            throw new GameRoomAccessService.Forbidden(
                "operator has not provisioned this broadcast source");
        byte[] bytes=new byte[32];
        GRANT_RANDOM.nextBytes(bytes);
        String secret=Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        Instant issued=Instant.now(),expires=issued.plusSeconds(ttlSeconds);
        rooms.write(connection->{
            Room room=GameRoomService.read(connection,roomId);
            requireDrawing(room);
            if(room.state()!=RoomState.OPEN_LOBBY
                && room.state()!=RoomState.PLAYING)
                throw new GameRoomService.RoomConflict("room not eligible for grant");
            try(var active=connection.prepareStatement("""
                SELECT 1 FROM game_room_drawing_broadcast_binding
                WHERE room_id=? AND provider=? AND channel_id=?
                  AND authorized_at IS NOT NULL
                """)) {
                active.setString(1,roomId);
                active.setString(2,name);
                active.setString(3,channel);
                try(var rows=active.executeQuery()) {
                    if(rows.next())throw new GameRoomService.RoomConflict(
                        "channel already authorized");
                }
            }
            try(var pending=connection.prepareStatement("""
                SELECT channel_id,provider
                FROM game_room_drawing_broadcast_grant
                WHERE room_id=? AND consumed_at IS NULL
                  AND julianday(expires_at)>julianday(?)
                """)) {
                pending.setString(1,roomId);
                pending.setString(2,issued.toString());
                int count=0;
                try(var rows=pending.executeQuery()) {
                    while(rows.next()) {
                        count++;
                        if(name.equals(rows.getString(2))
                            && channel.equals(rows.getString(1)))
                            throw new GameRoomService.RoomConflict(
                                "pending grant exists: revoke before reissuing");
                    }
                }
                if(count>=8)throw new GameRoomService.RoomConflict(
                    "too many outstanding channel grants");
            }
            try(var insert=connection.prepareStatement("""
                INSERT INTO game_room_drawing_broadcast_grant(
                    grant_hash,room_id,provider,channel_id,issued_at,
                    expires_at,consumed_at) VALUES(?,?,?,?,?,?,NULL)
                """)) {
                insert.setString(1,grantHash(secret));
                insert.setString(2,roomId);
                insert.setString(3,name);
                insert.setString(4,channel);
                insert.setString(5,issued.toString());
                insert.setString(6,expires.toString());
                insert.executeUpdate();
            }
            return null;
        });
        return new ChannelGrant(secret,name,channel,roomId,expires.toString());
    }

    /** The one-time grant is consumed in the SAME transaction as binding. */
    public List<BroadcastChannel> addChannel(String token,String provider,
                                            String channelId,String grant)
        throws SQLException {
        String name=broadcastProvider(provider),channel=broadcastChannel(channelId);
        rooms.write(connection -> {
            Room room=authorizedChannelHost(connection,token);
            if(!operatorSource.test(new BroadcastChannel(name,channel)))
                throw new GameRoomAccessService.Forbidden(
                    "broadcast source not operator provisioned");
            boolean existing=false;
            try(var lookup=connection.prepareStatement("""
                SELECT authorized_at FROM game_room_drawing_broadcast_binding
                WHERE room_id=? AND provider=? AND channel_id=?
                """)) {
                lookup.setString(1,room.roomId());
                lookup.setString(2,name);
                lookup.setString(3,channel);
                try(var rows=lookup.executeQuery()) {
                    if(rows.next()) {
                        if(rows.getString(1)!=null)return null;
                        existing=true; // unverified V38 label is not authority
                    }
                }
            }
            if(!existing) {
                try(var limit=connection.prepareStatement("""
                    SELECT COUNT(*) FROM game_room_drawing_broadcast_binding
                    WHERE room_id=?
                    """)) {
                    limit.setString(1,room.roomId());
                    try(var rows=limit.executeQuery()) {
                        if(rows.next() && rows.getInt(1)>=8)
                            throw new GameRoomService.RoomConflict(
                                "at most eight broadcast channels per room");
                    }
                }
            }
            if(grant==null || !grant.matches("[A-Za-z0-9_-]{43}"))
                throw new GameRoomAccessService.Forbidden("channel grant required");
            String now=Instant.now().toString();
            try(var consume=connection.prepareStatement("""
                UPDATE game_room_drawing_broadcast_grant
                SET consumed_at=?
                WHERE grant_hash=? AND room_id=? AND provider=? AND channel_id=?
                  AND consumed_at IS NULL
                  AND julianday(expires_at)>julianday(?)
                """)) {
                consume.setString(1,now);
                consume.setString(2,grantHash(grant));
                consume.setString(3,room.roomId());
                consume.setString(4,name);
                consume.setString(5,channel);
                consume.setString(6,now);
                if(consume.executeUpdate()!=1)
                    throw new GameRoomAccessService.Forbidden(
                        "channel grant invalid, expired or already consumed");
            }
            if(existing) {
                try(var update=connection.prepareStatement("""
                    UPDATE game_room_drawing_broadcast_binding
                    SET authorized_at=? WHERE room_id=? AND provider=?
                      AND channel_id=? AND authorized_at IS NULL
                    """)) {
                    update.setString(1,now);
                    update.setString(2,room.roomId());
                    update.setString(3,name);
                    update.setString(4,channel);
                    if(update.executeUpdate()!=1)
                        throw new GameRoomService.RoomConflict(
                            "channel binding changed");
                }
            } else {
                try(var insert=connection.prepareStatement("""
                    INSERT INTO game_room_drawing_broadcast_binding(
                        room_id,provider,channel_id,added_at,authorized_at)
                    VALUES(?,?,?,?,?)
                    """)) {
                    insert.setString(1,room.roomId());
                    insert.setString(2,name);
                    insert.setString(3,channel);
                    insert.setString(4,now);
                    insert.setString(5,now);
                    try {insert.executeUpdate();}
                    catch(SQLException conflict) {
                        if(conflict.getErrorCode()!=19)throw conflict;
                        throw new GameRoomService.RoomConflict(
                            "broadcast channel already bound to another room");
                    }
                }
            }
            return null;
        });
        return channels(token);
    }

    private static String grantHash(String secret) {
        try {
            byte[] bytes=MessageDigest.getInstance("SHA-256").digest(
                secret.getBytes(StandardCharsets.US_ASCII));
            return java.util.HexFormat.of().formatHex(bytes);
        } catch(NoSuchAlgorithmException missing) {
            throw new IllegalStateException("SHA-256 unavailable",missing);
        }
    }

    public List<BroadcastChannel> removeChannel(String token,String provider,
                                               String channelId) throws SQLException {
        String name=broadcastProvider(provider),channel=broadcastChannel(channelId);
        rooms.write(connection -> {
            Room room=authorizedChannelHost(connection,token);
            try(var statement=connection.prepareStatement("""
                DELETE FROM game_room_drawing_broadcast_binding
                WHERE room_id=? AND provider=? AND channel_id=?
                """)) {
                statement.setString(1,room.roomId());
                statement.setString(2,name);
                statement.setString(3,channel);
                statement.executeUpdate();
            }
            return null;
        });
        return channels(token);
    }

    private Room authorizedChannelHost(java.sql.Connection connection,String token)
        throws SQLException {
        var caller=access.requireSession(connection,token);
        Room room=GameRoomService.read(connection,caller.roomId());
        requireDrawing(room);
        if(!caller.isHost() || !connected(room,caller.memberId()))
            throw new GameRoomAccessService.Forbidden("connected host required");
        if(room.state()!=RoomState.OPEN_LOBBY && room.state()!=RoomState.PLAYING)
            throw new GameRoomService.RoomConflict("room no longer accepts channels");
        return room;
    }

    private static String broadcastProvider(String raw) {
        String provider=raw==null?"":raw.trim().toUpperCase(java.util.Locale.ROOT);
        if(!provider.matches("[A-Z][A-Z0-9_]{0,31}")
            || "GAMECENTER".equals(provider))
            throw new IllegalArgumentException("invalid external broadcast provider");
        return provider;
    }

    private static String broadcastChannel(String raw) {
        String channel=raw==null?"":raw.trim();
        if(!channel.matches("[A-Za-z0-9_.:-]{1,128}"))
            throw new IllegalArgumentException("invalid broadcast channel ID");
        return channel;
    }

    /** Host-only lobby mapping: operator permission is already verified by R12c. */
    public List<StreamerAssignment> streamerAssignments(String token)
        throws SQLException {
        var principal=access.authenticate(token);
        if(!principal.isHost())throw new GameRoomAccessService.Forbidden(
            "only host can inspect streamer seats");
        Room room=access.room(token);
        requireDrawing(room);
        var result=new ArrayList<StreamerAssignment>();
        try(var conn=rooms.databaseForAccess().open();
            var stmt=conn.prepareStatement("""
                SELECT provider,channel_id,drawer_member_id
                FROM game_room_drawing_broadcast_binding
                WHERE room_id=? AND authorized_at IS NOT NULL
                  AND drawer_member_id IS NOT NULL
                ORDER BY provider,channel_id
                """)) {
            stmt.setString(1,room.roomId());
            try(var rows=stmt.executeQuery()) {
                while(rows.next())result.add(new StreamerAssignment(
                    rows.getString(1),rows.getString(2),rows.getString(3)));
            }
        }
        return List.copyOf(result);
    }

    /** The host chooses the actual connected PLAYER seat for an approved feed. */
    public List<StreamerAssignment> assignStreamer(String token,
        String provider,String channelId,String memberId)throws SQLException {
        String name=broadcastProvider(provider),channel=broadcastChannel(channelId);
        String target=memberId==null?"":memberId.trim();
        if(!target.isEmpty() && !target.matches("[0-9a-f-]{36}"))
            throw new IllegalArgumentException("invalid game room member");
        rooms.write(connection->{
            var caller=access.requireSession(connection,token);
            Room room=GameRoomService.read(connection,caller.roomId());
            requireDrawing(room);
            if(!caller.isHost() || !connected(room,caller.memberId()))
                throw new GameRoomAccessService.Forbidden("connected host required");
            if(room.state()!=RoomState.OPEN_LOBBY)
                throw new GameRoomService.RoomConflict(
                    "streamer assignments freeze at game start");
            if(!target.isEmpty())
                requireConnectedPlayer(room,target);
            try(var stmt=connection.prepareStatement("""
                UPDATE game_room_drawing_broadcast_binding
                SET drawer_member_id=?
                WHERE room_id=? AND provider=? AND channel_id=?
                  AND authorized_at IS NOT NULL
                """)) {
                stmt.setString(1,target.isEmpty()?null:target);
                stmt.setString(2,room.roomId());
                stmt.setString(3,name);
                stmt.setString(4,channel);
                if(stmt.executeUpdate()!=1)
                    throw new GameRoomService.RoomConflict(
                        "approved broadcast channel required");
            }
            return null;
        });
        return streamerAssignments(token);
    }

    /** Ordered immutable reservation, deliberately independent of channel revocation. */
    private List<String> frozenDrawerIds(String roomId)throws SQLException {
        var ids=new ArrayList<String>();
        try(var connection=rooms.databaseForAccess().open();
            var stmt=connection.prepareStatement("""
                SELECT member_id FROM game_room_drawing_drawer_roster
                WHERE room_id=? ORDER BY drawer_order
                """)) {
            stmt.setString(1,roomId);
            try(var rows=stmt.executeQuery()){
                while(rows.next())ids.add(rows.getString(1));
            }
        }
        return List.copyOf(ids);
    }

    /** Prompt is private and authored by the EXACT current DRAWER member. */
    public Snapshot startRound(String token,String promptId,String answer,
                               List<String> accepted)throws SQLException {
        var principal=access.authenticate(token);
        var room=access.room(token);
        var binding=required(room);
        requireConnectedPlayer(room,principal.memberId());
        var game=drawing.publicRoom(binding.nativeRoomId());
        if(game.activeMatch()==null || game.activeRound()!=null)
            throw new GameRoomService.RoomConflict("round already active or match ended");
        int next=repository.nextRoundIndex(game.activeMatch().matchId());
        if(next>=game.activeMatch().totalRounds())
            throw new GameRoomService.RoomConflict("match rounds exhausted");
        String drawer=expectedDrawer(binding,next);
        if(!drawer.equals(principal.memberId()))
            throw new GameRoomAccessService.Forbidden("not selected drawer");
        drawing.startRound(game.activeMatch().matchId(),
            new DrawingGuessGameService.StartRoundCommand(promptId,answer,accepted),
            Instant.now());
        // Crucial: do NOT return RoundPrivate or DrawerSession to a public
        // projection. The raw answer and Canvas token stay server-side.
        return state(token);
    }

    /** The current drawer alone may recover the word after browser refresh. */
    public PrivatePrompt myPrompt(String token)throws SQLException {
        var principal=access.authenticate(token);
        Room room=access.room(token);
        Binding binding=required(room);
        requireConnectedPlayer(room,principal.memberId());
        var match=repository.findActiveMatchByRoom(binding.nativeRoomId());
        if(match==null)throw new GameRoomService.RoomConflict("no active match");
        var round=repository.findActiveRoundByMatch(match.matchId());
        if(round==null || !round.drawerParticipantId().equals(principal.memberId()))
            throw new GameRoomAccessService.Forbidden("not active drawer");
        return new PrivatePrompt(round.roundId(),round.prompt().answer(),
            round.prompt().acceptedAnswers());
    }

    /** Only current drawer may append a trusted, bounded Canvas event. */
    public CanvasEvent draw(String token,String rawJson)throws SQLException {
        var principal=access.authenticate(token);
        Room room=access.room(token);
        Binding binding=required(room);
        requireConnectedPlayer(room,principal.memberId());
        var match=repository.findActiveMatchByRoom(binding.nativeRoomId());
        if(match==null)throw new GameRoomService.RoomConflict("no match");
        var round=repository.findActiveRoundByMatch(match.matchId());
        if(round==null || !round.drawerParticipantId().equals(principal.memberId()))
            throw new GameRoomAccessService.Forbidden("not active drawer");
        if(!Instant.now().isBefore(Instant.parse(round.expiresAt())))
            throw new GameRoomService.RoomConflict("drawing round expired");
        var canonical=canvas.appendForAuthorizedRound(round.roundId(),rawJson);
        String code=canvas.drawingCodeForRound(round.roundId());
        try {broadcast.accept(code,canonical);}
        catch(RuntimeException ignored) {/* persistent Canvas history replayable */}
        return new CanvasEvent(round.roundId(),canonical);
    }

    /** R2 membership is the sole identity source; never read provider IDs
     * from untrusted POST bodies. General room chat remains separate. */
    public Guess guess(String token,String message)throws SQLException {
        if(message==null || message.isBlank() || message.length()>300)
            throw new IllegalArgumentException("invalid guess");
        var principal=access.authenticate(token);
        Room room=access.room(token);
        Binding binding=required(room);
        Member sender=room.members().stream()
            .filter(m->m.memberId().equals(principal.memberId()))
            .findFirst().orElseThrow(()->new GameRoomAccessService.Forbidden("unknown member"));
        if(sender.status()!=MemberStatus.JOINED)
            throw new GameRoomAccessService.Forbidden("disconnected member");
        var result=drawing.processChatMessage(new ChatMessageEvent(
            "GAMECENTER",room.roomId(),principal.memberId(),
            sender.displayName(),message,null,System.currentTimeMillis()));
        return new Guess(result.status(),result.rank(),
            result.guesserScore(),result.drawerScore());
    }

    public Snapshot completeRound(String token)throws SQLException {
        var principal=access.authenticate(token);
        var room=access.room(token);
        if(!connected(room,principal.memberId()))
            throw new GameRoomAccessService.Forbidden(
                "disconnected member cannot complete round");
        Binding binding=required(room);
        var match=repository.findActiveMatchByRoom(binding.nativeRoomId());
        if(match==null)throw new GameRoomService.RoomConflict("match ended");
        var round=repository.findActiveRoundByMatch(match.matchId());
        if(round==null)throw new GameRoomService.RoomConflict("no active round");
        if(!principal.isHost() && !principal.memberId().equals(round.drawerParticipantId()))
            throw new GameRoomAccessService.Forbidden("only host/drawer may complete");
        drawing.completeRound(round.roundId());
        return state(token);
    }

    public Snapshot finish(String token)throws SQLException {
        var principal=access.authenticate(token);
        if(!principal.isHost() || !connected(access.room(token),principal.memberId()))
            throw new GameRoomAccessService.Forbidden("connected host required");
        Room room=access.room(token);
        Binding binding=required(room);
        var match=repository.findActiveMatchByRoom(binding.nativeRoomId());
        if(match==null)throw new GameRoomService.RoomConflict("no active match");
        if(repository.nextRoundIndex(match.matchId())<match.totalRounds())
            throw new GameRoomService.RoomConflict("finish all rounds");
        drawing.completeMatch(match.matchId());
        rooms.write(connection->{
            Room current=GameRoomService.read(connection,room.roomId());
            if(current.state()==RoomState.PLAYING) {
                try(var stmt=connection.prepareStatement("""
                    UPDATE game_room SET state='POST_GAME' WHERE room_id=?
                    """)) {
                    stmt.setString(1,room.roomId());
                    stmt.executeUpdate();
                }
                rooms.bump(connection,current);
            }
            return null;
        });
        return state(token);
    }

    private Snapshot snapshot(Room room,String memberId,Binding binding,
                              DrawingGuessGameService.PublicRoomSnapshot game)
        throws SQLException {
        boolean activeDrawer=game.activeRound()!=null
            && game.activeRound().drawerParticipantId().equals(memberId);
        String nextDrawer=null;
        if(game.activeMatch()!=null && game.activeRound()==null) {
            int index=repository.nextRoundIndex(game.activeMatch().matchId());
            if(index<game.activeMatch().totalRounds())
                nextDrawer=expectedDrawer(binding,index);
        }
        return new Snapshot(room,memberId,binding.mode(),binding.nativeRoomId(),
            game,activeDrawer && connected(room,memberId),nextDrawer,
            binding.configuredRounds(),binding.durationSeconds(),
            binding.streamerRotation());
    }

    private Binding required(Room room)throws SQLException {
        requireDrawing(room);
        if(room.state()!=RoomState.PLAYING)
            throw new GameRoomService.RoomConflict("not an active Drawing room");
        Binding binding=binding(room.roomId());
        if(binding==null || binding.nativeRoomId()==null)
            throw new GameRoomService.RoomConflict("Drawing initialization pending");
        return binding;
    }

    private Binding binding(String roomId)throws SQLException {
        try(var connection=rooms.databaseForAccess().open();
            var stmt=connection.prepareStatement("""
                SELECT drawing_room_id,match_id,drawer_policy,configured_rounds,
                       duration_seconds,streamer_rotation
                FROM game_room_drawing_link WHERE room_id=?
                """)) {
            stmt.setString(1,roomId);
            try(var rows=stmt.executeQuery()){
                return rows.next()?new Binding(rows.getString(1),
                    rows.getString(2),DrawerPolicy.valueOf(rows.getString(3)),
                    rows.getInt(4),rows.getInt(5),rows.getInt(6)==1):null;
            }
        }
    }

    private String expectedDrawer(Binding binding,int index)
        throws SQLException {
        // Use the native match's immutable ordered roster, NOT the mutable
        // membership occupancy. Kick/disconnect must not silently reassign
        // another member's drawing turn or diverge from DrawingGuessGameService.
        var nativeRoom=repository.findRoom(binding.nativeRoomId());
        if(binding.mode()==DrawerPolicy.STREAMER_DRAWER)
            return nativeRoom.streamerParticipantId();
        var roster=nativeRoom.participants().stream()
            .filter(DrawingGuessRepository.Participant::canDraw).toList();
        if(roster.isEmpty())
            throw new GameRoomService.RoomConflict("frozen drawer roster unavailable");
        return roster.get(index % roster.size()).participantId();
    }

    private static void requireDrawing(Room room) {
        if(!"drawing_guess".equals(room.gameId()))
            throw new GameRoomService.RoomConflict("not Drawing Guess");
    }
    private static boolean connected(Room room,String id) {
        return room.members().stream().anyMatch(m->m.memberId().equals(id)
            && m.status()==MemberStatus.JOINED);
    }
    private static void requireConnectedPlayer(Room room,String memberId) {
        if(room.members().stream().noneMatch(m->m.memberId().equals(memberId)
            && m.status()==MemberStatus.JOINED && m.seatRole()==SeatRole.PLAYER))
            throw new GameRoomAccessService.Forbidden("active player required");
    }
    private static List<Member> players(Room room) {
        return room.members().stream().filter(m->m.occupies()
            && m.seatRole()==SeatRole.PLAYER).toList();
    }
    private record Reservation(Room room,DrawerPolicy mode,int rounds,
                               int seconds,String hostId,boolean streamerRotation) {}
    private record Binding(String nativeRoomId,String matchId,DrawerPolicy mode,
                           int configuredRounds,int durationSeconds,
                           boolean streamerRotation) {}
}
