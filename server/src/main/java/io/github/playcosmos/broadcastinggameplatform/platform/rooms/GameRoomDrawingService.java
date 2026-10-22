package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.ClassicScorePolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingScorePolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.GuessJudge;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Member;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.MemberStatus;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Room;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.RoomState;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.UUID;

/**
 * R5 lobby -> rotating DRAWER adapter. Never changes the broadcaster's
 * legacy STREAMER_DRAWER flow or routes. Shared room identity is the sole
 * source of who is playing/observing; existing D2 services own the match,
 * prompt and canvas. Private answer/token is returned ONLY to actual drawer.
 */
public final class GameRoomDrawingService {
    private static final Object START_GUARD = new Object();
    private final GameRoomService rooms;
    private final GameRoomAccessService access;
    private final DrawingGuessGameService drawing;
    private final DrawingGuessRepository repository;
    private final DrawingSyncService sync;

    public record State(Room room, DrawingGuessGameService.PublicRoomSnapshot drawing,
                        String memberId, boolean isDrawer, int totalRounds) {}
    public record PrivateDrawer(String roundId, String answer, String drawingCode,
                                String drawerToken, String expiresAt) {}
    public record Guess(String status, int points, int rank, String roundId) {}
    public record RoundView(State state, PrivateDrawer privateDrawer) {}

    public GameRoomDrawingService(DatabaseAccess db, GameRoomAccessService access,
                                  DrawingGuessGameService drawing,
                                  DrawingGuessRepository repository,
                                  DrawingSyncService sync) {
        this.rooms=new GameRoomService(Objects.requireNonNull(db));
        this.access=Objects.requireNonNull(access);
        this.drawing=Objects.requireNonNull(drawing);
        this.repository=Objects.requireNonNull(repository);
        this.sync=Objects.requireNonNull(sync);
    }

    public State state(String token) throws SQLException {
        var principal=access.authenticate(token);
        Room room=access.room(token);
        ensureGame(room);
        var link=link(room.roomId());
        var publicGame=link==null ? null : drawing.publicRoom(link.nativeRoom());
        boolean drawer=publicGame!=null && publicGame.activeRound()!=null
            && publicGame.activeRound().drawerParticipantId().equals(principal.memberId())
            && room.members().stream().anyMatch(m ->
                m.memberId().equals(principal.memberId())
                && m.status()==MemberStatus.JOINED && m.seatRole()==SeatRole.PLAYER);
        return new State(room,publicGame,principal.memberId(),drawer,
            link==null ? 0 : link.totalRounds());
    }

    /**
     * Creates a native rotating-player match from ONLY ready player seats.
     * The common lobby locks on start; no late players can alter drawer order.
     * R5 has one native match per common room.
     */
    public State start(String hostToken,int totalRounds,int durationSeconds)
        throws SQLException {
        if(totalRounds<2 || totalRounds>120 || durationSeconds<10
            || durationSeconds>600)throw new IllegalArgumentException("invalid match configuration");
        synchronized(START_GUARD) {
            var principal=access.authenticate(hostToken);
            if(!principal.isHost()) throw new GameRoomAccessService.Forbidden(
                "only room owner starts drawing match");
            Room locked=rooms.write(connection -> {
                var host=access.requireSession(connection,hostToken);
                Room room=GameRoomService.read(connection,host.roomId());
                ensureGame(room);
                if(!host.isHost() || getMember(room,host.memberId()).status()!=MemberStatus.JOINED)
                    throw new GameRoomAccessService.Forbidden("host not connected");
                if(room.state()!=RoomState.OPEN_LOBBY
                    && room.state()!=RoomState.PLAYING)
                    throw new GameRoomService.RoomConflict("room cannot start match");
                var players=players(room);
                if(players.size()<2 || players.size()>20)
                    throw new GameRoomService.RoomConflict("requires 2-20 players");
                if(room.state()==RoomState.OPEN_LOBBY){
                    if(players.stream().anyMatch(m ->
                        m.status()!=MemberStatus.JOINED || !m.ready()))
                        throw new GameRoomService.RoomConflict("all players must be ready");
                    try(var stmt=connection.prepareStatement("""
                        UPDATE game_room SET state='PLAYING' WHERE room_id=?
                        """)){
                        stmt.setString(1,room.roomId());
                        stmt.executeUpdate();
                    }
                    rooms.bump(connection,room);
                }
                return room;
            });
            var existing=link(locked.roomId());
            if(existing!=null){
                if(existing.totalRounds()!=totalRounds)
                    throw new GameRoomService.RoomConflict("match settings locked");
                return state(hostToken);
            }
            // Native D2 createRoom is its own committed transaction. Crash
            // after this step can leave an unlinked DRAFT room; it cannot
            // gain member access and must be reconciled by a future cleaner.
            var inputs=new ArrayList<DrawingGuessRepository.ParticipantInput>();
            for(var m:players(locked))inputs.add(
                new DrawingGuessRepository.ParticipantInput(
                    m.memberId(),null,null,m.displayName(),true));
            var nativeRoom=drawing.createRoom(
                new DrawingGuessGameService.CreateRoomCommand(
                    locked.roomName(),DrawerPolicy.ROTATING_DRAWER,null,
                    ClassicScorePolicy.Config.defaults(),durationSeconds,
                    false,null,null,List.copyOf(inputs)));
            drawing.markReady(nativeRoom.roomId());
            var match=drawing.startMatch(nativeRoom.roomId(),totalRounds);
            rooms.write(connection -> {
                try(var stmt=connection.prepareStatement("""
                    INSERT INTO game_room_drawing_link
                      (room_id,drawing_room_code,match_id,total_rounds,created_at)
                    VALUES(?,?,?,?,?)
                    """)){
                    stmt.setString(1,locked.roomId());
                    stmt.setString(2,nativeRoom.roomId());
                    stmt.setString(3,match.matchId());
                    stmt.setInt(4,totalRounds);
                    stmt.setString(5,Instant.now().toString());
                    stmt.executeUpdate();
                }
                return null;
            });
            return state(hostToken);
        }
    }

    /**
     * Only the next round's actual PLAYER can supply the SECRET prompt and
     * receive the private canvas token. A spectator or room host who is not
     * drawer must not learn the answer.
     */
    public RoundView nextRound(String token,String answer,List<String> alternatives)
        throws SQLException {
        var principal=access.authenticate(token);
        Room room=access.room(token);
        ensureGame(room);
        var member=getMember(room,principal.memberId());
        if(room.state()!=RoomState.PLAYING
            || member.status()!=MemberStatus.JOINED
            || member.seatRole()!=SeatRole.PLAYER)
            throw new GameRoomAccessService.Forbidden("active player required");
        var linked=requireLink(room.roomId());
        var match=repository.findMatch(linked.matchId());
        if(!"ACTIVE".equals(match.state()))
            throw new GameRoomService.RoomConflict("match has ended");
        int index=repository.nextRoundIndex(linked.matchId());
        var nativeRoom=repository.findRoom(linked.nativeRoom());
        var order=nativeRoom.participants().stream()
            .filter(DrawingGuessRepository.Participant::canDraw).toList();
        if(index>=linked.totalRounds())
            throw new GameRoomService.RoomConflict("all rounds completed");
        String drawer=order.get(index%order.size()).participantId();
        if(!principal.memberId().equals(drawer))
            throw new GameRoomAccessService.Forbidden("not the next drawer");
        if(repository.findActiveRoundByMatch(linked.matchId())!=null)
            throw new GameRoomService.RoomConflict("finish active round first");
        var started=drawing.startRound(linked.matchId(),
            new DrawingGuessGameService.StartRoundCommand(
                "room-"+UUID.randomUUID(),answer,alternatives),Instant.now());
        var privateInfo=new PrivateDrawer(
            started.privateRound().roundId(),started.privateRound().prompt().answer(),
            started.drawingSession().drawingCode(),
            started.drawingSession().drawerToken(),
            started.drawingSession().expiresAt());
        return new RoundView(state(token),privateInfo);
    }

    /** The canvas token is reissued only for the same current drawer. */
    public PrivateDrawer recoverDrawer(String token) throws SQLException {
        var principal=access.authenticate(token);
        var room=access.room(token);
        var member=getMember(room,principal.memberId());
        if(member.status()!=MemberStatus.JOINED || member.seatRole()!=SeatRole.PLAYER)
            throw new GameRoomAccessService.Forbidden("only joined drawer can recover");
        var linked=requireLink(room.roomId());
        var round=repository.findActiveRoundByMatch(linked.matchId());
        if(round==null || !principal.memberId().equals(round.drawerParticipantId()))
            throw new GameRoomAccessService.Forbidden("not active drawer");
        var recovery=drawing.recoverDrawerRound(round.roundId());
        return new PrivateDrawer(round.roundId(),round.prompt().answer(),
            recovery.drawingSession().drawingCode(),
            recovery.drawingSession().drawerToken(),
            recovery.drawingSession().expiresAt());
    }

    /** Separate gameplay guess input, never the room chat channel. */
    public synchronized Guess guess(String token,String content) throws SQLException {
        if(content==null || content.isBlank() || content.length()>200)
            throw new IllegalArgumentException("invalid guess");
        var principal=access.authenticate(token);
        var room=access.room(token);
        var member=getMember(room,principal.memberId());
        if(member.status()!=MemberStatus.JOINED || member.seatRole()!=SeatRole.PLAYER)
            throw new GameRoomAccessService.Forbidden("only player may guess");
        var linked=requireLink(room.roomId());
        var round=repository.findActiveRoundByMatch(linked.matchId());
        if(round==null)return new Guess("NO_ACTIVE_ROUND",0,0,null);
        if(member.memberId().equals(round.drawerParticipantId()))
            throw new GameRoomAccessService.Forbidden("drawer cannot guess own secret");
        Instant now=Instant.now(), expiry=Instant.parse(round.expiresAt());
        if(!now.isBefore(expiry))
            return new Guess("ROUND_EXPIRED",0,0,round.roundId());
        var publicRound=repository.findRoundPublic(round.roundId());
        for(var result:publicRound.correctGuesses()) {
            if(result.participantId().equals(member.memberId()))
                return new Guess("DUPLICATE_CORRECT",
                    result.scoreAwarded(),result.rank(),round.roundId());
        }
        if(!new GuessJudge().isCorrect(round.prompt(),content))
            return new Guess("WRONG",0,0,round.roundId());
        var nativeRoom=repository.findRoom(linked.nativeRoom());
        int rank=publicRound.correctGuesses().size()+1;
        var award=new ClassicScorePolicy(nativeRoom.scoreConfig()).score(
            new DrawingScorePolicy.ScoreContext(
                Duration.between(Instant.parse(round.startedAt()),expiry),
                Duration.between(Instant.parse(round.startedAt()),now),
                rank,Math.max(0,players(room).size()-1)));
        repository.recordCorrectGuess(round.roundId(),member.memberId(),
            member.displayName(),rank,award.guesserPoints(),award.drawerPoints(),now);
        return new Guess("CORRECT",award.guesserPoints(),rank,round.roundId());
    }

    public State completeRound(String token) throws SQLException {
        var principal=access.authenticate(token);
        var room=access.room(token);
        var linked=requireLink(room.roomId());
        var round=repository.findActiveRoundByMatch(linked.matchId());
        if(round==null)throw new GameRoomService.RoomConflict("no active round");
        if(!principal.isHost() && !principal.memberId().equals(round.drawerParticipantId()))
            throw new GameRoomAccessService.Forbidden("only host or drawer may end round");
        drawing.completeRound(round.roundId());
        return state(token);
    }

    public State completeMatch(String token) throws SQLException {
        var principal=access.authenticate(token);
        if(!principal.isHost())throw new GameRoomAccessService.Forbidden(
            "only room host may finish match");
        var room=access.room(token);
        var linked=requireLink(room.roomId());
        var match=repository.findMatch(linked.matchId());
        if(repository.findActiveRoundByMatch(linked.matchId())!=null
            || repository.nextRoundIndex(linked.matchId())<linked.totalRounds())
            throw new GameRoomService.RoomConflict("complete all rounds first");
        if("ACTIVE".equals(match.state()))drawing.completeMatch(match.matchId());
        rooms.write(connection -> {
            var current=GameRoomService.read(connection,room.roomId());
            if(current.state()==RoomState.PLAYING){
                try(var stmt=connection.prepareStatement(
                    "UPDATE game_room SET state='POST_GAME' WHERE room_id=?")){
                    stmt.setString(1,room.roomId());
                    stmt.executeUpdate();
                }
                rooms.bump(connection,current);
            }
            return null;
        });
        return state(token);
    }

    private record Link(String nativeRoom,String matchId,int totalRounds) {}
    private Link link(String roomId) throws SQLException {
        try(var connection=rooms.databaseForAccess().open();
            var stmt=connection.prepareStatement("""
                SELECT drawing_room_code,match_id,total_rounds
                FROM game_room_drawing_link WHERE room_id=?
                """)){
            stmt.setString(1,roomId);
            try(var rows=stmt.executeQuery()){
                return rows.next()?new Link(rows.getString(1),
                    rows.getString(2),rows.getInt(3)):null;
            }
        }
    }
    private Link requireLink(String roomId) throws SQLException {
        var existing=link(roomId);
        if(existing==null)throw new GameRoomService.RoomConflict("drawing match not started");
        return existing;
    }
    private static void ensureGame(Room room) {
        if(!"drawing_guess".equals(room.gameId()))
            throw new GameRoomService.RoomConflict("not a Drawing Guess room");
    }
    private static Member getMember(Room room,String memberId) {
        return room.members().stream().filter(m -> m.memberId().equals(memberId))
            .findFirst().orElseThrow(() -> new NoSuchElementException("room member missing"));
    }
    private static List<Member> players(Room room) {
        return room.members().stream()
            .filter(m->m.occupies() && m.seatRole()==SeatRole.PLAYER).toList();
    }
}
