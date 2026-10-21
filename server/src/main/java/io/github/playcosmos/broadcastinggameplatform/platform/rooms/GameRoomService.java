package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Member;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.MemberStatus;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Room;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.RoomState;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.UUID;

/**
 * Internal R1-only GameRoom authority. Caller-supplied actorId MUST come
 * from a trusted server identity; no HTTP or guest authentication exists until
 * R2. SQLite BEGIN IMMEDIATE serializes capacity checks and writes across
 * service instances/processes, rather than relying on a Java monitor.
 *
 * No Board, Drawing Guess or Yacht match/score tables are touched here.
 */
public final class GameRoomService {
    private static final String CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final SecureRandom RANDOM = new SecureRandom();
    // Technical protection only, NOT a final game/product capacity setting.
    private static final int ABSOLUTE_MEMBER_LIMIT = 256;
    private final DatabaseAccess database;
    private final Clock clock;

    public static final class RoomConflict extends IllegalStateException {
        public RoomConflict(String message) { super(message); }
    }

    @FunctionalInterface
    interface SqlWork<T> { T run(Connection connection) throws SQLException; }

    public GameRoomService(DatabaseAccess database) {
        this(database, Clock.systemUTC());
    }

    public GameRoomService(DatabaseAccess database, Clock clock) {
        this.database = Objects.requireNonNull(database, "database");
        this.clock = Objects.requireNonNull(clock, "clock");
    }
    
    DatabaseAccess databaseForAccess() { return database; }

    public Room create(String gameId, String roomName, String actorId,
                       String displayName, SeatRole hostSeat,
                       int maxPlayers, int maxRoomMembers) throws SQLException {
        validateGameId(gameId);
        if (roomName == null || roomName.isBlank() || roomName.length() > 100) {
            throw new IllegalArgumentException("invalid room name");
        }
        validateActor(actorId, displayName);
        Objects.requireNonNull(hostSeat, "hostSeat");
        validateCapacity(maxPlayers, maxRoomMembers);
        return write(connection -> {
            String roomId = UUID.randomUUID().toString();
            String ownerId = UUID.randomUUID().toString();
            String roomCode = allocateCode(connection, gameId);
            String now = now();
            try (var stmt = connection.prepareStatement("""
                INSERT INTO game_room (
                  room_id,game_id,room_name,room_code,owner_member_id,state,
                  max_players,max_room_members,version,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,0,?,?)
                """)) {
                stmt.setString(1, roomId);
                stmt.setString(2, gameId);
                stmt.setString(3, roomName);
                stmt.setString(4, roomCode);
                stmt.setString(5, ownerId);
                stmt.setString(6, RoomState.OPEN_LOBBY.name());
                stmt.setInt(7, maxPlayers);
                stmt.setInt(8, maxRoomMembers);
                stmt.setString(9, now);
                stmt.setString(10, now);
                stmt.executeUpdate();
            }
            insertMember(connection, ownerId, roomId, actorId, displayName,
                hostSeat, now);
            return read(connection, roomId);
        });
    }

    public Room find(String roomId) throws SQLException {
        requireId(roomId, "roomId");
        try (var connection = database.open()) {
            return read(connection, roomId);
        }
    }

    /** A game code is scoped to its game, never globally authorized. */
    public Room findByCode(String gameId, String roomCode) throws SQLException {
        validateGameId(gameId);
        if (roomCode == null || !roomCode.matches("[A-HJ-NP-Z2-9]{6}")) {
            throw new NoSuchElementException("room not found");
        }
        try (var connection = database.open();
             var stmt = connection.prepareStatement("""
                 SELECT room_id FROM game_room WHERE game_id=? AND room_code=?
                 """)) {
            stmt.setString(1, gameId);
            stmt.setString(2, roomCode);
            try (var rows = stmt.executeQuery()) {
                if (!rows.next()) throw new NoSuchElementException("room not found");
                return read(connection, rows.getString(1));
            }
        }
    }

    public Room join(String roomId, String actorId, String displayName,
                     SeatRole seat) throws SQLException {
        requireId(roomId, "roomId");
        validateActor(actorId, displayName);
        Objects.requireNonNull(seat, "seat");
        return write(connection -> {
            Room room = read(connection, roomId);
            requireOpen(room);
            Member previous = room.memberForActor(actorId);
            if (previous != null && previous.status() == MemberStatus.KICKED) {
                throw new RoomConflict("member blocked");
            }
            if (previous != null && previous.occupies()) {
                // Duplicate connection is the same person, not another seat.
                if (previous.seatRole() != seat) {
                    throw new RoomConflict("use seat change for existing member");
                }
                return room;
            }
            checkAvailable(room, seat);
            String now = now();
            if (previous == null) {
                insertMember(connection, UUID.randomUUID().toString(), roomId,
                    actorId, displayName, seat, now);
            } else {
                try (var stmt = connection.prepareStatement("""
                    UPDATE game_room_member SET membership_status='JOINED',
                      display_name=?,seat_role=?,ready=0,
                      grace_expires_at=NULL,joined_at=?
                    WHERE room_id=? AND member_id=? AND membership_status='LEFT'
                    """)) {
                    stmt.setString(1, displayName);
                    stmt.setString(2, seat.name());
                    stmt.setString(3, now);
                    stmt.setString(4, roomId);
                    stmt.setString(5, previous.memberId());
                    if (stmt.executeUpdate() != 1) throw new RoomConflict("invalid rejoin");
                }
            }
            bump(connection, room);
            return read(connection, roomId);
        });
    }

    /** Promotion never increases total occupancy; only player seats. */
    public Room changeSeat(String roomId, String actorId, SeatRole seat)
        throws SQLException {
        Objects.requireNonNull(seat, "seat");
        return mutateMember(roomId, actorId, (connection, room, member) -> {
            requireOpen(room);
            if (member.status() != MemberStatus.JOINED) {
                throw new RoomConflict("member must be connected");
            }
            if (member.seatRole() == seat) return false;
            if (seat == SeatRole.PLAYER && room.playerCount() >= room.maxPlayers()) {
                throw new RoomConflict("player capacity reached");
            }
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_member SET seat_role=?,ready=0 WHERE member_id=?
                """)) {
                stmt.setString(1, seat.name());
                stmt.setString(2, member.memberId());
                stmt.executeUpdate();
            }
            return true;
        });
    }

    public Room setReady(String roomId, String actorId, boolean ready)
        throws SQLException {
        return mutateMember(roomId, actorId, (connection, room, member) -> {
            requireOpen(room);
            if (member.status() != MemberStatus.JOINED
                || member.seatRole() != SeatRole.PLAYER) {
                throw new RoomConflict("only connected players can be ready");
            }
            if (member.ready() == ready) return false;
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_member SET ready=? WHERE member_id=?
                """)) {
                stmt.setInt(1, ready ? 1 : 0);
                stmt.setString(2, member.memberId());
                stmt.executeUpdate();
            }
            return true;
        });
    }

    /**
     * R1 tracks transient disconnect without freeing either seat. A trusted
     * server decides a future expiry/forfeit policy in R2/R4/R5.
     */
    public Room disconnect(String roomId, String actorId, Duration grace)
        throws SQLException {
        Objects.requireNonNull(grace, "grace");
        if (grace.isNegative() || grace.isZero() || grace.compareTo(Duration.ofHours(1)) > 0) {
            throw new IllegalArgumentException("invalid disconnect grace");
        }
        return mutateMember(roomId, actorId, (connection, room, member) -> {
            if (member.status() != MemberStatus.JOINED) {
                throw new RoomConflict("member is not connected");
            }
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_member SET membership_status='DISCONNECTED_GRACE',
                  ready=0, grace_expires_at=? WHERE member_id=?
                """)) {
                stmt.setString(1, clock.instant().plus(grace).toString());
                stmt.setString(2, member.memberId());
                stmt.executeUpdate();
            }
            return true;
        });
    }

    public Room reconnect(String roomId, String actorId) throws SQLException {
        return mutateMember(roomId, actorId, (connection, room, member) -> {
            if (member.status() != MemberStatus.DISCONNECTED_GRACE
                || member.graceExpiresAt() == null
                || clock.instant().isAfter(Instant.parse(member.graceExpiresAt()))) {
                throw new RoomConflict("reconnect not permitted");
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

    public Room leave(String roomId, String actorId) throws SQLException {
        return mutateMember(roomId, actorId, (connection, room, member) -> {
            if (member.memberId().equals(room.ownerMemberId())) {
                throw new RoomConflict("owner must transfer room in R2 before leaving");
            }
            if (!member.occupies()) throw new RoomConflict("member has left");
            if (room.state() == RoomState.PLAYING
                && member.seatRole() == SeatRole.PLAYER) {
                throw new RoomConflict("active player removal requires game policy");
            }
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room_member SET membership_status='LEFT',
                  ready=0,grace_expires_at=NULL WHERE member_id=?
                """)) {
                stmt.setString(1, member.memberId());
                stmt.executeUpdate();
            }
            return true;
        });
    }

    public Room setCapacity(String roomId, int maxPlayers, int maxRoomMembers)
        throws SQLException {
        validateCapacity(maxPlayers, maxRoomMembers);
        return write(connection -> {
            Room room = read(connection, roomId);
            requireOpen(room);
            if (maxPlayers < room.playerCount()
                || maxRoomMembers < room.memberCount()) {
                throw new RoomConflict("cannot shrink below occupied capacity");
            }
            if (room.maxPlayers() == maxPlayers
                && room.maxRoomMembers() == maxRoomMembers) return room;
            try (var stmt = connection.prepareStatement("""
                UPDATE game_room SET max_players=?,max_room_members=?
                WHERE room_id=? AND version=?
                """)) {
                stmt.setInt(1, maxPlayers);
                stmt.setInt(2, maxRoomMembers);
                stmt.setString(3, roomId);
                stmt.setLong(4, room.version());
                if (stmt.executeUpdate() != 1) throw new RoomConflict("stale room version");
            }
            bump(connection, room);
            return read(connection, roomId);
        });
    }

    @FunctionalInterface
    private interface MemberChange {
        boolean apply(Connection connection, Room room, Member member) throws SQLException;
    }

    private Room mutateMember(String roomId, String actorId, MemberChange change)
        throws SQLException {
        requireId(roomId, "roomId");
        requireId(actorId, "actorId");
        return write(connection -> {
            Room room = read(connection, roomId);
            if (room.state() == RoomState.CLOSED) throw new RoomConflict("room closed");
            Member member = room.memberForActor(actorId);
            if (member == null) throw new NoSuchElementException("room member not found");
            if (change.apply(connection, room, member)) bump(connection, room);
            return read(connection, roomId);
        });
    }

    <T> T write(SqlWork<T> operation) throws SQLException {
        try (var connection = database.open();
             var control = connection.createStatement()) {
            // Acquire the SQLite writer reservation BEFORE checking occupancy.
            // Lock spans all membership and version changes, including readers
            // on other JDBC sessions, and rolls back on every failure.
            control.execute("BEGIN IMMEDIATE");
            boolean committed = false;
            try {
                T result = operation.run(connection);
                control.execute("COMMIT");
                committed = true;
                return result;
            } finally {
                if (!committed) control.execute("ROLLBACK");
            }
        }
    }

    static Room read(Connection connection, String roomId) throws SQLException {
        try (var stmt = connection.prepareStatement("""
            SELECT game_id,room_name,room_code,owner_member_id,state,max_players,
                   max_room_members,version FROM game_room WHERE room_id=?
            """)) {
            stmt.setString(1, roomId);
            try (var rows = stmt.executeQuery()) {
                if (!rows.next()) throw new NoSuchElementException("room not found");
                String gameId = rows.getString(1), name = rows.getString(2);
                String code = rows.getString(3);
                String ownerId = rows.getString(4);
                RoomState state = RoomState.valueOf(rows.getString(5));
                int players = rows.getInt(6), members = rows.getInt(7);
                long version = rows.getLong(8);
                var roster = new ArrayList<Member>();
                try (var memberStmt = connection.prepareStatement("""
                    SELECT member_id,actor_id,display_name,seat_role,
                           membership_status,ready,grace_expires_at,joined_at
                    FROM game_room_member WHERE room_id=?
                    ORDER BY joined_at,member_id
                    """)) {
                    memberStmt.setString(1, roomId);
                    try (var memberRows = memberStmt.executeQuery()) {
                        while (memberRows.next()) roster.add(new Member(
                            memberRows.getString(1), memberRows.getString(2),
                            memberRows.getString(3),
                            SeatRole.valueOf(memberRows.getString(4)),
                            MemberStatus.valueOf(memberRows.getString(5)),
                            memberRows.getInt(6) != 0,
                            memberRows.getString(7), memberRows.getString(8)
                        ));
                    }
                }
                return new Room(roomId, gameId, name, code, ownerId, state,
                    players, members, version, roster);
            }
        }
    }

    static void insertMember(Connection connection, String memberId,
        String roomId, String actorId, String displayName, SeatRole seat,
        String now) throws SQLException {
        try (var stmt = connection.prepareStatement("""
            INSERT INTO game_room_member(
              member_id,room_id,actor_id,display_name,seat_role,
              membership_status,ready,grace_expires_at,joined_at
            ) VALUES(?,?,?,?,?,'JOINED',0,NULL,?)
            """)) {
            stmt.setString(1, memberId);
            stmt.setString(2, roomId);
            stmt.setString(3, actorId);
            stmt.setString(4, displayName);
            stmt.setString(5, seat.name());
            stmt.setString(6, now);
            stmt.executeUpdate();
        }
    }

    void bump(Connection connection, Room room) throws SQLException {
        try (var stmt = connection.prepareStatement("""
            UPDATE game_room SET version=?,updated_at=?
            WHERE room_id=? AND version=?
            """)) {
            stmt.setLong(1, room.version() + 1);
            stmt.setString(2, now());
            stmt.setString(3, room.roomId());
            stmt.setLong(4, room.version());
            if (stmt.executeUpdate() != 1) throw new RoomConflict("room version conflict");
        }
    }

    private static String allocateCode(Connection connection, String gameId)
        throws SQLException {
        for (int attempt = 0; attempt < 100; attempt++) {
            var builder = new StringBuilder(6);
            for (int index = 0; index < 6; index++) {
                builder.append(CODE_ALPHABET.charAt(RANDOM.nextInt(CODE_ALPHABET.length())));
            }
            String candidate = builder.toString();
            try (var stmt = connection.prepareStatement("""
                SELECT 1 FROM game_room WHERE game_id=? AND room_code=?
                """)) {
                stmt.setString(1, gameId);
                stmt.setString(2, candidate);
                try (var rows = stmt.executeQuery()) {
                    if (!rows.next()) return candidate;
                }
            }
        }
        throw new RoomConflict("room code allocation exhausted");
    }

    private void checkAvailable(Room room, SeatRole seat) {
        if (room.memberCount() + 1 > room.maxRoomMembers()) {
            throw new RoomConflict("room capacity reached");
        }
        if (seat == SeatRole.PLAYER && room.playerCount() + 1 > room.maxPlayers()) {
            throw new RoomConflict("player capacity reached");
        }
    }

    static void requireOpen(Room room) {
        if (room.state() != RoomState.OPEN_LOBBY
            && room.state() != RoomState.POST_GAME) {
            throw new RoomConflict("membership change requires lobby or post-game");
        }
    }

    static void validateCapacity(int players, int members) {
        if (players < 1 || members < players || members > ABSOLUTE_MEMBER_LIMIT) {
            throw new IllegalArgumentException("invalid room capacity");
        }
    }

    static void validateGameId(String gameId) {
        if (gameId == null || !gameId.matches("[a-z][a-z0-9_]{1,39}")) {
            throw new IllegalArgumentException("invalid game ID");
        }
    }

    static void validateActor(String actorId, String displayName) {
        requireId(actorId, "actorId");
        if (displayName == null || displayName.isBlank()
            || displayName.length() > 80) {
            throw new IllegalArgumentException("invalid display name");
        }
    }

    private static void requireId(String id, String label) {
        if (id == null || id.isBlank() || id.length() > 128) {
            throw new IllegalArgumentException("invalid " + label);
        }
    }

    private String now() { return clock.instant().toString(); }
}
