package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.domain.YachtMatchState;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRoomService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Member;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.MemberStatus;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Room;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.RoomState;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Objects;

/**
 * R4 adapter. A shared GameRoom tracks seats/chat/host, while Yacht Y2
 * remains the ONLY authority for dice, turn rotation and scoring.
 *
 * All membership credentials are revalidated for every command. Game setup
 * freezes the lobby before initializing Yacht; idempotent Y2 create/activate
 * IDs make interrupted startups repeatable without duplicate matches.
 */
public final class GameRoomYachtService {
    private final GameRoomService rooms;
    private final GameRoomAccessService access;
    private final YachtRoomService yacht;

    public record State(Room room, YachtRoomService.RoomState yacht,
                        String memberId, boolean currentPlayer) {}

    public GameRoomYachtService(DatabaseAccess database,
                               GameRoomAccessService access,
                               YachtRoomService yacht) {
        this.rooms = new GameRoomService(Objects.requireNonNull(database));
        this.access = Objects.requireNonNull(access);
        this.yacht = Objects.requireNonNull(yacht);
    }

    public State state(String token) throws SQLException {
        var principal = access.authenticate(token);
        Room room = access.room(token);
        requireYacht(room);
        String code = linkedCode(room.roomId());
        YachtRoomService.RoomState match = code == null ? null : yacht.state(code);
        if (match != null) synchronizeFinished(room.roomId(), match.match().phase());
        Room refreshed = access.room(token);
        return new State(refreshed, match, principal.memberId(),
            match != null && match.match().phase() == YachtMatchState.Phase.ACTIVE
            && match.match().activePlayer().id().equals(principal.memberId()));
    }

    /**
     * Only the connected HOST can lock a fully ready player roster.
     * PLAYING is deliberately persisted before creating the Y2 match. If a
     * process stops in the middle, the same host can retry; no member/seat
     * changes are possible in the meantime.
     */
    public State start(String token) throws SQLException {
        var principal = access.authenticate(token);
        if (!principal.isHost()) throw new GameRoomAccessService.Forbidden(
            "only current host may start Yacht");
        var frozen = rooms.write(connection -> {
            var current = access.requireSession(connection,token);
            if (!current.isHost() || !current.memberId().equals(principal.memberId())) {
                throw new GameRoomAccessService.Forbidden("host changed");
            }
            Room room = GameRoomService.read(connection,principal.roomId());
            requireYacht(room);
            Member host = requireMember(room,principal.memberId());
            if (host.status()!=MemberStatus.JOINED) {
                throw new GameRoomAccessService.Forbidden("host is offline");
            }
            if (room.state() != RoomState.OPEN_LOBBY
                && room.state() != RoomState.PLAYING) {
                throw new GameRoomService.RoomConflict("Yacht room cannot start");
            }
            List<Member> players = playingMembers(room);
            if (players.size() < 2 || players.size() > 6) {
                throw new GameRoomService.RoomConflict("Yacht needs 2 to 6 players");
            }
            if (room.state() == RoomState.OPEN_LOBBY) {
                if (players.stream().anyMatch(m -> m.status() != MemberStatus.JOINED
                    || !m.ready())) {
                    throw new GameRoomService.RoomConflict(
                        "all connected players must be ready");
                }
                try(var stmt=connection.prepareStatement("""
                    UPDATE game_room SET state='PLAYING' WHERE room_id=? AND version=?
                    """)) {
                    stmt.setString(1,room.roomId());
                    stmt.setLong(2,room.version());
                    if(stmt.executeUpdate()!=1)
                        throw new GameRoomService.RoomConflict("room version conflict");
                }
                rooms.bump(connection,room);
            }
            return room;
        });
        String existing = linkedCode(frozen.roomId());
        if (existing == null) {
            var players = new ArrayList<YachtRoomService.Participant>();
            for (Member m : playingMembers(frozen)) {
                players.add(new YachtRoomService.Participant(
                    m.memberId(),m.displayName()));
            }
            var created = yacht.create("common-yacht-" + frozen.roomId(),
                frozen.roomName(),players);
            if (created.match().phase() == YachtMatchState.Phase.READY) {
                yacht.command(created.roomCode(),"activate",
                    new YachtRoomService.Command(
                        "common-start-" + frozen.roomId(),0,null,null));
            }
            // A concurrent retry can reach this commit after the first
            // writer; SQLite prevents two different native match bindings.
            rooms.write(connection -> {
                try(var stmt=connection.prepareStatement("""
                    INSERT INTO game_room_yacht_link(room_id,yacht_room_code,created_at)
                    VALUES(?,?,?) ON CONFLICT(room_id) DO NOTHING
                    """)) {
                    stmt.setString(1,frozen.roomId());
                    stmt.setString(2,created.roomCode());
                    stmt.setString(3,Instant.now().toString());
                    stmt.executeUpdate();
                }
                return null;
            });
            String actual = linkedCode(frozen.roomId());
            if (!created.roomCode().equals(actual)) {
                throw new GameRoomService.RoomConflict("Yacht binding conflict");
            }
        }
        return state(token);
    }

    /**
     * Authenticated PLAYER may operate only if they OWN the actual
     * server-authoritative turn. A host who is a spectator cannot roll.
     */
    public State command(String token, String action,
                         YachtRoomService.Command command) throws SQLException {
        var principal=access.authenticate(token);
        Room room=access.room(token);
        requireYacht(room);
        if (room.state() != RoomState.PLAYING
            && room.state() != RoomState.POST_GAME) {
            throw new GameRoomService.RoomConflict("room is not playing");
        }
        Member member=requireMember(room,principal.memberId());
        if (member.seatRole()!=SeatRole.PLAYER
            || member.status()!=MemberStatus.JOINED) {
            throw new GameRoomAccessService.Forbidden("only joined player can act");
        }
        if (!List.of("roll","hold","score").contains(action)) {
            throw new GameRoomAccessService.Forbidden(
                "players cannot control match lifecycle");
        }
        String code=linkedCode(room.roomId());
        if (code==null) throw new GameRoomService.RoomConflict("Yacht not started");
        var before=yacht.state(code);
        // A duplicate score request can be delivered after FINISHED; the
        // Y2 command service checks and replays its original command ID.
        if (before.match().phase()==YachtMatchState.Phase.ACTIVE) {
            if (!before.match().activePlayer().id().equals(principal.memberId())) {
                throw new GameRoomAccessService.Forbidden("not your Yacht turn");
            }
        } else if (before.match().phase()!=YachtMatchState.Phase.FINISHED
            || !"score".equals(action)) {
            throw new GameRoomService.RoomConflict("Yacht match not active");
        }
        var after=yacht.command(code,action,command);
        synchronizeFinished(room.roomId(),after.match().phase());
        return new State(access.room(token),after,principal.memberId(),
            after.match().phase()==YachtMatchState.Phase.ACTIVE
            && after.match().activePlayer().id().equals(principal.memberId()));
    }

    private void synchronizeFinished(String roomId,YachtMatchState.Phase phase)
        throws SQLException {
        if (phase != YachtMatchState.Phase.FINISHED) return;
        rooms.write(connection -> {
            Room current=GameRoomService.read(connection,roomId);
            if (current.state()==RoomState.PLAYING) {
                try(var stmt=connection.prepareStatement("""
                    UPDATE game_room SET state='POST_GAME' WHERE room_id=?
                    """)) {
                    stmt.setString(1,roomId);
                    stmt.executeUpdate();
                }
                rooms.bump(connection,current);
            }
            return null;
        });
    }

    private String linkedCode(String roomId) throws SQLException {
        try(var connection=rooms.databaseForAccess().open();
            var stmt=connection.prepareStatement("""
                SELECT yacht_room_code FROM game_room_yacht_link WHERE room_id=?
                """)) {
            stmt.setString(1,roomId);
            try(var rows=stmt.executeQuery()){
                return rows.next()?rows.getString(1):null;
            }
        }
    }

    private static void requireYacht(Room room) {
        if (!"yacht".equals(room.gameId())) {
            throw new GameRoomService.RoomConflict("not a Yacht game room");
        }
    }
    private static Member requireMember(Room room,String memberId) {
        return room.members().stream()
            .filter(m -> m.memberId().equals(memberId))
            .findFirst().orElseThrow(() -> new NoSuchElementException("not a member"));
    }
    private static List<Member> playingMembers(Room room) {
        return room.members().stream()
            .filter(m -> m.occupies() && m.seatRole()==SeatRole.PLAYER)
            .toList();
    }
}
