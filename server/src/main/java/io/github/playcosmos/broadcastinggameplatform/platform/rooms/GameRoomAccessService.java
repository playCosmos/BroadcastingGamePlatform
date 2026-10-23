package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Member;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.MemberStatus;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Room;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.UUID;

/**
 * R2 authenticated membership boundary. Tokens are 256-bit secure random,
 * stored only as hashes. All privileged checks, role changes, invite counts
 * and revocations use the SAME R1 BEGIN IMMEDIATE SQLite transaction.
 *
 * This API is a trusted server boundary. In particular createHostedRoom()
 * must only be called after ADMIN authorization; never bind it directly to
 * an unauthenticated HTTP route. R2 HTTP handler performs that guard.
 */
public final class GameRoomAccessService {
    private static final SecureRandom RNG = new SecureRandom();
    private static final Base64.Encoder TOKEN_ENCODER =
        Base64.getUrlEncoder().withoutPadding();
    private static final Duration MEMBER_TTL = Duration.ofDays(7);
    private static final Duration MAX_INVITE_TTL = Duration.ofDays(7);
    private static final int MAX_INVITE_USES = 256;
    private final GameRoomService rooms;
    private final Clock clock;
    private volatile java.util.function.BiConsumer<String,String> memberRevocationListener=
        (roomId,memberId)->{};

    /** Optional server transport hook, invoked only after committed revocation. */
    public void setMemberRevocationListener(
        java.util.function.BiConsumer<String,String> listener
    ) {
        memberRevocationListener=java.util.Objects.requireNonNull(listener);
    }

    private void notifyMemberRevoked(String roomId,String memberId) {
        try {memberRevocationListener.accept(roomId,memberId);}
        catch(RuntimeException failure) {
            System.err.println("[room-auth] websocket revocation signal failed");
        }
    }

    public static final class Forbidden extends SecurityException {
        public Forbidden(String reason) { super(reason); }
    }

    /** Contains a SECRET: never persist, log or include in public room views. */
    public record Credential(String token, String roomId, String memberId) {}
    public record HostedRoom(Room room, Credential hostCredential) {}
    public record Invitation(String token, String roomId, SeatRole role,
                             int uses, Instant expiresAt) {}
    public record Principal(String roomId, String memberId, String actorId,
                            boolean isHost, SeatRole seatRole) {}

    public GameRoomAccessService(DatabaseAccess database) {
        this(database, Clock.systemUTC());
    }

    public GameRoomAccessService(DatabaseAccess database, Clock clock) {
        this.rooms = new GameRoomService(database, clock);
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /**
     * SERVER/ADMIN-ONLY bootstrap; a random actor identity is generated on
     * the server instead of trusting an unverified web-supplied actor ID.
     */
    public HostedRoom createHostedRoom(String gameId, String roomName,
                                      String displayName, SeatRole hostSeat,
                                      int maxPlayers, int maxMembers)
        throws SQLException {
        return rooms.write(connection -> {
            var room = rooms.createInTransaction(connection,
                gameId, roomName, "guest-" + UUID.randomUUID(),
                displayName, hostSeat, maxPlayers, maxMembers);
            Credential secret = issueSession(connection,
                room.roomId(), room.ownerMemberId());
            return new HostedRoom(room, secret);
        });
    }

    public Principal authenticate(String token) throws SQLException {
        try (var connection = openRead()) {
            return requireSession(connection, token);
        }
    }

    /** Never include this raw domain projection in anonymous/public JSON. */
    public Room room(String token) throws SQLException {
        try (var connection = openRead()) {
            Principal principal = requireSession(connection, token);
            return GameRoomService.read(connection, principal.roomId());
        }
    }

    public Invitation invite(String hostToken, SeatRole role, int uses,
                             Duration lifetime) throws SQLException {
        Objects.requireNonNull(role, "role");
        validateInvite(uses, lifetime);
        return rooms.write(connection -> {
            Principal host = requireHost(connection, hostToken);
            Room room = GameRoomService.read(connection, host.roomId());
            if (room.state() == GameRoomModels.RoomState.PLAYING
                && role != SeatRole.SPECTATOR) {
                throw new GameRoomService.RoomConflict(
                    "cannot invite new players during an active match");
            }
            if (room.state() != GameRoomModels.RoomState.PLAYING) {
                GameRoomService.requireOpen(room);
            }
            String secret = secret(), timestamp = now();
            Instant expires = clock.instant().plus(lifetime);
            try (var statement = connection.prepareStatement("""
                INSERT INTO game_room_invite
                (invite_hash,room_id,seat_role,max_uses,used,expires_at,
                 revoked_at,created_by_member_id,created_at)
                VALUES(?,?,?,?,0,?,NULL,?,?)
                """)) {
                statement.setString(1, hash(secret));
                statement.setString(2, room.roomId());
                statement.setString(3, role.name());
                statement.setInt(4, uses);
                statement.setString(5, expires.toString());
                statement.setString(6, host.memberId());
                statement.setString(7, timestamp);
                statement.executeUpdate();
            }
            return new Invitation(secret, room.roomId(), role, uses, expires);
        });
    }

    /** A valid invite does NOT allow the client to choose their actor ID. */
    public Credential join(String inviteToken, String displayName)
        throws SQLException {
        if (displayName == null || displayName.isBlank()
            || displayName.length() > 80) {
            throw new IllegalArgumentException("invalid display name");
        }
        return rooms.write(connection -> {
            String inviteHash = hashToken(inviteToken);
            String roomId;
            SeatRole role;
            try (var statement = connection.prepareStatement("""
                SELECT room_id,seat_role FROM game_room_invite
                WHERE invite_hash=? AND revoked_at IS NULL
                  AND expires_at>? AND used<max_uses
                """)) {
                statement.setString(1, inviteHash);
                statement.setString(2, now());
                try (var rows = statement.executeQuery()) {
                    if (!rows.next()) throw new Forbidden("invite invalid or expired");
                    roomId = rows.getString(1);
                    role = SeatRole.valueOf(rows.getString(2));
                }
            }
            Room room = GameRoomService.read(connection, roomId);
            if (room.state() == GameRoomModels.RoomState.PLAYING
                && role != SeatRole.SPECTATOR) {
                throw new GameRoomService.RoomConflict(
                    "cannot join as player during an active match");
            }
            if (room.state() != GameRoomModels.RoomState.PLAYING) {
                GameRoomService.requireOpen(room);
            }
            if (room.memberCount() >= room.maxRoomMembers()) {
                throw new GameRoomService.RoomConflict("room capacity reached");
            }
            if (role == SeatRole.PLAYER
                && room.playerCount() >= room.maxPlayers()) {
                throw new GameRoomService.RoomConflict("player capacity reached");
            }
            String actorId = "guest-" + UUID.randomUUID();
            String memberId = UUID.randomUUID().toString();
            GameRoomService.insertMember(connection, memberId, roomId, actorId,
                displayName, role, now());
            try (var update = connection.prepareStatement("""
                UPDATE game_room_invite SET used=used+1
                WHERE invite_hash=? AND used<max_uses AND revoked_at IS NULL
                """)) {
                update.setString(1, inviteHash);
                if (update.executeUpdate() != 1) {
                    throw new GameRoomService.RoomConflict("invite already consumed");
                }
            }
            rooms.bump(connection, room);
            return issueSession(connection, roomId, memberId);
        });
    }

    /**
     * Existing secret is sufficient to reclaim the SAME member after a
     * transient disconnect. Stolen/expired/revoked secret is never valid.
     */
    public Room reconnect(String token) throws SQLException {
        return mutate(token, (connection, principal, room, member) -> {
            if (member.status() != MemberStatus.DISCONNECTED_GRACE
                || member.graceExpiresAt() == null
                || clock.instant().isAfter(Instant.parse(member.graceExpiresAt()))) {
                throw new GameRoomService.RoomConflict("reconnect grace expired");
            }
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_member SET membership_status='JOINED',
                  grace_expires_at=NULL WHERE member_id=?
                """)) {
                stmt.setString(1, member.memberId());
                stmt.executeUpdate();
            }
            return true;
        });
    }

    public Room disconnect(String token, Duration grace) throws SQLException {
        if (grace == null || grace.isNegative() || grace.isZero()
            || grace.compareTo(Duration.ofHours(1)) > 0) {
            throw new IllegalArgumentException("invalid disconnect grace");
        }
        Principal leaving=authenticate(token);
        Room result=mutate(token, (connection, principal, room, member) -> {
            if (member.status() != MemberStatus.JOINED) {
                throw new GameRoomService.RoomConflict("not connected");
            }
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_member SET membership_status='DISCONNECTED_GRACE',
                   ready=0,grace_expires_at=? WHERE member_id=?
                """)) {
                stmt.setString(1, clock.instant().plus(grace).toString());
                stmt.setString(2, member.memberId());
                stmt.executeUpdate();
            }
            return true;
        });
        notifyMemberRevoked(leaving.roomId(),leaving.memberId());
        return result;
    }

    public Room ready(String token, boolean desired) throws SQLException {
        return mutate(token, (connection, principal, room, member) -> {
            GameRoomService.requireOpen(room);
            if (member.status() != MemberStatus.JOINED
                || member.seatRole() != SeatRole.PLAYER) {
                throw new Forbidden("only connected player can ready");
            }
            if (member.ready() == desired) return false;
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_member SET ready=? WHERE member_id=?
                """)) {
                stmt.setInt(1, desired ? 1 : 0);
                stmt.setString(2, member.memberId());
                stmt.executeUpdate();
            }
            return true;
        });
    }

    public Room seat(String token, SeatRole target) throws SQLException {
        Objects.requireNonNull(target, "seat");
        return mutate(token, (connection, principal, room, member) -> {
            GameRoomService.requireOpen(room);
            if (member.status() != MemberStatus.JOINED) {
                throw new Forbidden("member not connected");
            }
            if (target == member.seatRole()) return false;
            if (target == SeatRole.PLAYER
                && room.playerCount() >= room.maxPlayers()) {
                throw new GameRoomService.RoomConflict("player capacity reached");
            }
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_member SET seat_role=?,ready=0
                WHERE member_id=?
                """)) {
                stmt.setString(1, target.name());
                stmt.setString(2, member.memberId());
                stmt.executeUpdate();
            }
            return true;
        });
    }

    public Room leave(String token) throws SQLException {
        Principal leaving=authenticate(token);
        Room result=mutate(token, (connection, principal, room, member) -> {
            if (principal.isHost()) {
                throw new GameRoomService.RoomConflict("transfer host before leaving");
            }
            if (room.state() == GameRoomModels.RoomState.PLAYING
                && member.seatRole() == SeatRole.PLAYER) {
                throw new GameRoomService.RoomConflict("player cannot leave active game");
            }
            if (member.status() != MemberStatus.JOINED) {
                throw new Forbidden("member not connected");
            }
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_member
                SET membership_status='LEFT',ready=0,grace_expires_at=NULL
                WHERE member_id=?
                """)) {
                stmt.setString(1, member.memberId());
                stmt.executeUpdate();
            }
            revokeMember(connection, member.memberId());
            return true;
        });
        notifyMemberRevoked(leaving.roomId(),leaving.memberId());
        return result;
    }

    public Room capacity(String hostToken, int players, int total)
        throws SQLException {
        GameRoomService.validateCapacity(players, total);
        return rooms.write(connection -> {
            Principal host = requireHost(connection, hostToken);
            Room room = GameRoomService.read(connection, host.roomId());
            GameRoomService.requireOpen(room);
            if (players < room.playerCount() || total < room.memberCount()) {
                throw new GameRoomService.RoomConflict("capacity below occupancy");
            }
            if (players == room.maxPlayers() && total == room.maxRoomMembers()) return room;
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room SET max_players=?,max_room_members=? WHERE room_id=?
                """)) {
                stmt.setInt(1, players);
                stmt.setInt(2, total);
                stmt.setString(3, room.roomId());
                stmt.executeUpdate();
            }
            rooms.bump(connection, room);
            return GameRoomService.read(connection, room.roomId());
        });
    }

    public Room transferHost(String hostToken, String targetMemberId)
        throws SQLException {
        return rooms.write(connection -> {
            Principal host = requireHost(connection, hostToken);
            Room room = GameRoomService.read(connection, host.roomId());
            GameRoomService.requireOpen(room);
            Member target = member(room, targetMemberId);
            if (target.status() != MemberStatus.JOINED) {
                throw new Forbidden("new host must be connected");
            }
            if (room.ownerMemberId().equals(targetMemberId)) return room;
            try (var statement = connection.prepareStatement("""
                UPDATE game_room SET owner_member_id=? WHERE room_id=?
                """)) {
                statement.setString(1, targetMemberId);
                statement.setString(2, room.roomId());
                statement.executeUpdate();
            }
            rooms.bump(connection, room);
            return GameRoomService.read(connection, room.roomId());
        });
    }

    public Room kick(String hostToken, String targetMemberId) throws SQLException {
        Room result=rooms.write(connection -> {
            Principal host = requireHost(connection, hostToken);
            Room room = GameRoomService.read(connection, host.roomId());
            Member target = member(room, targetMemberId);
            if (target.memberId().equals(room.ownerMemberId())) {
                throw new Forbidden("cannot kick current host");
            }
            if (!target.occupies()) throw new GameRoomService.RoomConflict("not in room");
            if (room.state() == GameRoomModels.RoomState.PLAYING
                && target.seatRole() == SeatRole.PLAYER) {
                throw new GameRoomService.RoomConflict("game policy blocks active player removal");
            }
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_member SET membership_status='KICKED',
                  ready=0,grace_expires_at=NULL WHERE member_id=?
                """)) {
                stmt.setString(1, targetMemberId);
                stmt.executeUpdate();
            }
            try (var stmt = connection.prepareStatement("""
                INSERT INTO game_room_ban(room_id,actor_id,moderator_id,created_at)
                VALUES(?,?,?,?) ON CONFLICT(room_id,actor_id)
                DO UPDATE SET moderator_id=excluded.moderator_id,
                              created_at=excluded.created_at
                """)) {
                stmt.setString(1, room.roomId());
                stmt.setString(2, target.actorId());
                stmt.setString(3, host.memberId());
                stmt.setString(4, now());
                stmt.executeUpdate();
            }
            revokeMember(connection, targetMemberId);
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_invite SET revoked_at=?
                WHERE room_id=? AND created_by_member_id=? AND revoked_at IS NULL
                """)) {
                stmt.setString(1, now());
                stmt.setString(2, room.roomId());
                stmt.setString(3, targetMemberId);
                stmt.executeUpdate();
            }
            rooms.bump(connection, room);
            return GameRoomService.read(connection, room.roomId());
        });
        notifyMemberRevoked(result.roomId(),targetMemberId);
        return result;
    }

    /** Rotate credentials without opening another member seat or grace period. */
    public Credential rotate(String token) throws SQLException {
        Principal previous=authenticate(token);
        Credential rotated=rooms.write(connection -> {
            Principal principal = requireSession(connection, token);
            String oldHash = hashToken(token);
            String next = secret();
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_session SET revoked_at=?
                WHERE session_hash=? AND revoked_at IS NULL
                """)) {
                stmt.setString(1, now());
                stmt.setString(2, oldHash);
                if (stmt.executeUpdate() != 1) throw new Forbidden("session revoked");
            }
            return insertSession(connection, next, principal.roomId(), principal.memberId());
        });
        notifyMemberRevoked(previous.roomId(),previous.memberId());
        return rotated;
    }

    public void revoke(String token) throws SQLException {
        Principal previous=authenticate(token);
        rooms.write(connection -> {
            requireSession(connection, token);
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_session SET revoked_at=?
                WHERE session_hash=? AND revoked_at IS NULL
                """)) {
                stmt.setString(1, now());
                stmt.setString(2, hashToken(token));
                stmt.executeUpdate();
            }
            return null;
        });
        notifyMemberRevoked(previous.roomId(),previous.memberId());
    }

    public void revokeInvite(String hostToken, String inviteToken)
        throws SQLException {
        rooms.write(connection -> {
            Principal host = requireHost(connection, hostToken);
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_invite SET revoked_at=?
                WHERE invite_hash=? AND room_id=? AND revoked_at IS NULL
                """)) {
                stmt.setString(1, now());
                stmt.setString(2, hashToken(inviteToken));
                stmt.setString(3, host.roomId());
                if (stmt.executeUpdate() != 1) throw new Forbidden("invite unavailable");
            }
            return null;
        });
    }

    private interface Mutation {
        boolean apply(Connection connection, Principal principal, Room room, Member self)
            throws SQLException;
    }

    private Room mutate(String token, Mutation action) throws SQLException {
        return rooms.write(connection -> {
            Principal principal = requireSession(connection, token);
            Room room = GameRoomService.read(connection, principal.roomId());
            if (room.state() == GameRoomModels.RoomState.CLOSED) {
                throw new GameRoomService.RoomConflict("room closed");
            }
            Member current = member(room, principal.memberId());
            if (action.apply(connection, principal, room, current)) {
                rooms.bump(connection, room);
            }
            return GameRoomService.read(connection, principal.roomId());
        });
    }

    private Principal requireHost(Connection connection, String token)
        throws SQLException {
        Principal principal = requireSession(connection, token);
        if (!principal.isHost()) throw new Forbidden("host permission required");
        Member host = member(GameRoomService.read(connection, principal.roomId()),
            principal.memberId());
        if (host.status() != MemberStatus.JOINED) {
            throw new Forbidden("disconnected host cannot moderate");
        }
        return principal;
    }

    Principal requireSession(Connection connection, String token)
        throws SQLException {
        String hash = hashToken(token);
        try (var stmt = connection.prepareStatement("""
            SELECT s.room_id,s.member_id,m.actor_id,m.seat_role,m.membership_status,
                   r.owner_member_id,r.state
            FROM game_room_session s
            JOIN game_room_member m ON m.room_id=s.room_id AND m.member_id=s.member_id
            JOIN game_room r ON r.room_id=s.room_id
            WHERE s.session_hash=? AND s.revoked_at IS NULL
              AND s.expires_at>?
            """)) {
            stmt.setString(1, hash);
            stmt.setString(2, now());
            try (var rows = stmt.executeQuery()) {
                if (!rows.next()) throw new Forbidden("member session invalid or expired");
                if ("LEFT".equals(rows.getString(5)) || "KICKED".equals(rows.getString(5))
                    || "CLOSED".equals(rows.getString(7))) {
                    throw new Forbidden("room membership inactive");
                }
                return new Principal(rows.getString(1), rows.getString(2),
                    rows.getString(3), rows.getString(2).equals(rows.getString(6)),
                    SeatRole.valueOf(rows.getString(4)));
            }
        }
    }

    private Credential issueSession(Connection connection, String roomId,
                                     String memberId) throws SQLException {
        return insertSession(connection, secret(), roomId, memberId);
    }

    private Credential insertSession(Connection connection, String token,
                                     String roomId, String memberId) throws SQLException {
        try (var stmt = connection.prepareStatement("""
            INSERT INTO game_room_session(
                session_hash,room_id,member_id,expires_at,revoked_at,created_at
            ) VALUES(?,?,?,?,NULL,?)
            """)) {
            stmt.setString(1, hash(token));
            stmt.setString(2, roomId);
            stmt.setString(3, memberId);
            stmt.setString(4, clock.instant().plus(MEMBER_TTL).toString());
            stmt.setString(5, now());
            stmt.executeUpdate();
        }
        return new Credential(token, roomId, memberId);
    }

    private void revokeMember(Connection connection, String memberId)
        throws SQLException {
        try (var stmt = connection.prepareStatement("""
            UPDATE game_room_session SET revoked_at=?
            WHERE member_id=? AND revoked_at IS NULL
            """)) {
            stmt.setString(1, now());
            stmt.setString(2, memberId);
            stmt.executeUpdate();
        }
    }

    private static Member member(Room room, String memberId) {
        if (memberId == null) throw new Forbidden("member ID required");
        return room.members().stream()
            .filter(m -> m.memberId().equals(memberId))
            .findFirst().orElseThrow(() -> new Forbidden("member not in this room"));
    }

    private static void validateInvite(int uses, Duration ttl) {
        if (uses < 1 || uses > MAX_INVITE_USES || ttl == null
            || ttl.isZero() || ttl.isNegative() || ttl.compareTo(MAX_INVITE_TTL) > 0) {
            throw new IllegalArgumentException("invalid invite bounds");
        }
    }

    private Connection openRead() throws SQLException {
        // Existing database access is behind GameRoomService, with no hidden
        // process-local credentials or duplicated connection pool.
        return rooms.databaseForAccess().open();
    }

    private String now() { return clock.instant().toString(); }

    private static String secret() {
        byte[] raw = new byte[32];
        RNG.nextBytes(raw);
        return TOKEN_ENCODER.encodeToString(raw);
    }

    private static String hashToken(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{43}")) {
            throw new Forbidden("credential format invalid");
        }
        return hash(value);
    }

    private static String hash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 missing", impossible);
        }
    }
}
