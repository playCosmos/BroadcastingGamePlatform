package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Member;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.MemberStatus;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.Room;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.RoomState;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Gartic-inspired telephone mode, kept separate from scored Drawing Guess.
 * A member receives only their predecessor's submitted artifact; the entire
 * ordered album becomes visible to all room members ONLY after completion.
 * No browser-supplied album slot, author, or provider identity is trusted.
 */
public final class GameRoomTelephoneService {
    public record AlbumEntry(int stage,String kind,String content,String author) {}
    public record Album(String originalAuthor,List<AlbumEntry> entries) {}
    public record View(boolean active,String state,int stage,int stages,int seconds,
                       String stageStartedAt,int submitted,int participants,
                       String taskKind,String previousKind,String previousContent,
                       boolean mySubmitted,List<Album> albums) {}
    private record Match(int stage,int size,int seconds,String started,String state) {}
    private record Slot(int order,String memberId,String name) {}

    private final GameRoomService rooms;
    private final GameRoomAccessService access;

    public GameRoomTelephoneService(DatabaseAccess database,GameRoomAccessService access) {
        rooms=new GameRoomService(Objects.requireNonNull(database));
        this.access=Objects.requireNonNull(access);
    }

    public View start(String hostToken,int seconds)throws SQLException {
        if(seconds<30 || seconds>600)
            throw new IllegalArgumentException("turn timer must be 30..600 seconds");
        return rooms.write(conn->{
            var principal=access.requireSession(conn,hostToken);
            Room room=GameRoomService.read(conn,principal.roomId());
            drawing(room);
            if(!principal.isHost() || !connected(room,principal.memberId()))
                throw new GameRoomAccessService.Forbidden("connected host required");
            Match existing=match(conn,room.roomId());
            if(existing!=null) {
                if(existing.seconds()!=seconds)
                    throw new GameRoomService.RoomConflict("telephone configuration frozen");
                return view(conn,room,principal.memberId(),existing);
            }
            if(room.state()!=RoomState.OPEN_LOBBY)
                throw new GameRoomService.RoomConflict("room is not in lobby");
            var players=room.members().stream()
                .filter(m->m.occupies()&&m.seatRole()==SeatRole.PLAYER).toList();
            if(players.size()<3 || players.size()>12)
                throw new GameRoomService.RoomConflict("telephone requires 3..12 players");
            if(players.stream().anyMatch(m->m.status()!=MemberStatus.JOINED||!m.ready()))
                throw new GameRoomService.RoomConflict("all players must be ready");
            String now=Instant.now().toString();
            try(var add=conn.prepareStatement("""
                INSERT INTO game_room_telephone_match(
                  room_id,stage,roster_size,duration_seconds,stage_started_at,state)
                VALUES(?,0,?,?,?,'PLAYING')
                """)) {
                add.setString(1,room.roomId());add.setInt(2,players.size());
                add.setInt(3,seconds);add.setString(4,now);add.executeUpdate();
            }
            int order=0;
            for(Member m:players) {
                try(var insert=conn.prepareStatement("""
                    INSERT INTO game_room_telephone_player(
                      room_id,slot,member_id,display_name) VALUES(?,?,?,?)
                    """)) {
                    insert.setString(1,room.roomId());insert.setInt(2,order++);
                    insert.setString(3,m.memberId());insert.setString(4,m.displayName());
                    insert.executeUpdate();
                }
            }
            try(var state=conn.prepareStatement("""
                UPDATE game_room SET state='PLAYING'
                WHERE room_id=? AND state='OPEN_LOBBY' AND version=?
                """)) {
                state.setString(1,room.roomId());
                state.setLong(2,room.version());
                if(state.executeUpdate()!=1)
                    throw new GameRoomService.RoomConflict("stale game-room reservation");
            }
            rooms.bump(conn,room);
            return view(conn,GameRoomService.read(conn,room.roomId()),
                principal.memberId(),match(conn,room.roomId()));
        });
    }

    public View state(String token)throws SQLException {
        return rooms.write(conn->{
            var principal=access.requireSession(conn,token);
            Room room=GameRoomService.read(conn,principal.roomId());
            drawing(room);
            Match match=match(conn,room.roomId());
            if(match==null) return new View(false,"LOBBY",0,0,0,null,
                0,0,null,null,null,false,List.of());
            advanceExpired(conn,room,match);
            return view(conn,GameRoomService.read(conn,room.roomId()),
                principal.memberId(),match(conn,room.roomId()));
        });
    }

    public View submit(String token,String text,String drawingJson)throws SQLException {
        return submit(token,-1,text,drawingJson);
    }

    /** Browser requests must carry the exact phase they observed. */
    public View submit(String token,int expectedStage,String text,String drawingJson)
        throws SQLException {
        return rooms.write(conn->{
            var principal=access.requireSession(conn,token);
            Room room=GameRoomService.read(conn,principal.roomId());
            drawing(room);
            if(!connected(room,principal.memberId()))
                throw new GameRoomAccessService.Forbidden("connected player required");
            Match match=match(conn,room.roomId());
            if(match==null)throw new GameRoomService.RoomConflict("no telephone game");
            advanceExpired(conn,room,match);
            match=match(conn,room.roomId());
            if(!"PLAYING".equals(match.state()))
                throw new GameRoomService.RoomConflict("album reveal already started");
            if(expectedStage>=0 && expectedStage!=match.stage())
                throw new GameRoomService.RoomConflict("stale telephone stage");
            int slot=slot(conn,room.roomId(),principal.memberId());
            if(slot<0)throw new GameRoomAccessService.Forbidden(
                "only original frozen players may submit");
            int album=Math.floorMod(slot-match.stage(),match.size());
            boolean drawing=match.stage()%2==1;
            String content=drawing?normalizeDrawing(drawingJson):normalizeText(text);
            try(var insert=conn.prepareStatement("""
                INSERT INTO game_room_telephone_entry(
                  room_id,album_slot,stage,member_id,kind,content,submitted_at)
                VALUES(?,?,?,?,?,?,?)
                """)) {
                insert.setString(1,room.roomId());insert.setInt(2,album);
                insert.setInt(3,match.stage());insert.setString(4,principal.memberId());
                insert.setString(5,drawing?"DRAWING":"TEXT");
                insert.setString(6,content);insert.setString(7,Instant.now().toString());
                try{insert.executeUpdate();}
                catch(SQLException failure) {
                    if(failure.getErrorCode()!=19)throw failure;
                    throw new GameRoomService.RoomConflict("this stage already submitted");
                }
            }
            if(count(conn,room.roomId(),match.stage())==match.size())
                advance(conn,room,match);
            return view(conn,GameRoomService.read(conn,room.roomId()),
                principal.memberId(),match(conn,room.roomId()));
        });
    }

    private void advanceExpired(Connection conn,Room room,Match match)
        throws SQLException {
        if(!"PLAYING".equals(match.state()))return;
        Instant deadline=Instant.parse(match.started()).plusSeconds(match.seconds());
        if(Instant.now().isBefore(deadline))return;
        var members=roster(conn,room.roomId());
        for(Slot slot:members) {
            int album=Math.floorMod(slot.order()-match.stage(),match.size());
            try(var insert=conn.prepareStatement("""
                INSERT OR IGNORE INTO game_room_telephone_entry(
                  room_id,album_slot,stage,member_id,kind,content,submitted_at)
                VALUES(?,?,?,?,?,?,?)
                """)) {
                insert.setString(1,room.roomId());insert.setInt(2,album);
                insert.setInt(3,match.stage());insert.setString(4,slot.memberId());
                insert.setString(5,match.stage()%2==1?"DRAWING":"TEXT");
                insert.setString(6,match.stage()%2==1?"[]":"(시간 초과)");
                insert.setString(7,deadline.toString());insert.executeUpdate();
            }
        }
        advance(conn,room,match);
    }

    private void advance(Connection conn,Room room,Match old)throws SQLException {
        int next=old.stage()+1;
        try(var stmt=conn.prepareStatement("""
            UPDATE game_room_telephone_match
            SET stage=?,stage_started_at=?,state=?
            WHERE room_id=? AND stage=? AND state='PLAYING'
            """)) {
            stmt.setInt(1,next);stmt.setString(2,Instant.now().toString());
            stmt.setString(3,next>=old.size()?"REVEAL":"PLAYING");
            stmt.setString(4,room.roomId());stmt.setInt(5,old.stage());
            if(stmt.executeUpdate()!=1)throw new GameRoomService.RoomConflict(
                "stage changed concurrently");
        }
        if(next>=old.size()) {
            try(var update=conn.prepareStatement("""
                UPDATE game_room SET state='POST_GAME' WHERE room_id=? AND state='PLAYING'
                """)) {
                update.setString(1,room.roomId());update.executeUpdate();
            }
            rooms.bump(conn,room);
        }
    }

    private View view(Connection conn,Room room,String memberId,Match m)
        throws SQLException {
        boolean reveal="REVEAL".equals(m.state());
        int slot=slot(conn,room.roomId(),memberId);
        String kind=!reveal?(m.stage()%2==1?"DRAWING":"TEXT"):null;
        String previousKind=null,previousContent=null;
        boolean submitted=false;
        if(!reveal && slot>=0) {
            int album=Math.floorMod(slot-m.stage(),m.size());
            submitted=entry(conn,room.roomId(),album,m.stage())!=null;
            if(m.stage()>0){
                AlbumEntry previous=entry(conn,room.roomId(),album,m.stage()-1);
                if(previous!=null) {
                    previousKind=previous.kind();previousContent=previous.content();
                }
            }
        }
        return new View(true,m.state(),m.stage(),m.size(),m.seconds(),
            m.started(),reveal?m.size():count(conn,room.roomId(),m.stage()),
            m.size(),slot>=0?kind:null,previousKind,previousContent,
            submitted,reveal?albums(conn,room.roomId(),m.size()):List.of());
    }

    private List<Album> albums(Connection conn,String roomId,int size)
        throws SQLException {
        var result=new ArrayList<Album>();
        var roster=roster(conn,roomId);
        for(int index=0;index<size;index++) {
            var entries=new ArrayList<AlbumEntry>();
            for(int phase=0;phase<size;phase++) {
                var found=entry(conn,roomId,index,phase);
                if(found!=null)entries.add(found);
            }
            result.add(new Album(roster.get(index).name(),List.copyOf(entries)));
        }
        return List.copyOf(result);
    }

    private static AlbumEntry entry(Connection conn,String roomId,int album,int phase)
        throws SQLException {
        try(var stmt=conn.prepareStatement("""
            SELECT e.stage,e.kind,e.content,p.display_name
            FROM game_room_telephone_entry e
            JOIN game_room_telephone_player p
              ON p.room_id=e.room_id AND p.member_id=e.member_id
            WHERE e.room_id=? AND e.album_slot=? AND e.stage=?
            """)) {
            stmt.setString(1,roomId);stmt.setInt(2,album);stmt.setInt(3,phase);
            try(var rows=stmt.executeQuery()) {
                return rows.next()?new AlbumEntry(rows.getInt(1),
                    rows.getString(2),rows.getString(3),rows.getString(4)):null;
            }
        }
    }

    private static List<Slot> roster(Connection conn,String roomId)throws SQLException {
        var result=new ArrayList<Slot>();
        try(var stmt=conn.prepareStatement("""
            SELECT slot,member_id,display_name FROM game_room_telephone_player
            WHERE room_id=? ORDER BY slot
            """)) {
            stmt.setString(1,roomId);
            try(var rows=stmt.executeQuery()){
                while(rows.next())result.add(new Slot(
                    rows.getInt(1),rows.getString(2),rows.getString(3)));
            }
        }
        return List.copyOf(result);
    }

    private static int slot(Connection conn,String roomId,String memberId)
        throws SQLException {
        try(var stmt=conn.prepareStatement("""
            SELECT slot FROM game_room_telephone_player
            WHERE room_id=? AND member_id=?
            """)) {
            stmt.setString(1,roomId);stmt.setString(2,memberId);
            try(var rows=stmt.executeQuery()) {
                return rows.next()?rows.getInt(1):-1;
            }
        }
    }

    private static int count(Connection conn,String roomId,int stage)
        throws SQLException {
        try(var stmt=conn.prepareStatement("""
            SELECT COUNT(*) FROM game_room_telephone_entry
            WHERE room_id=? AND stage=?
            """)) {
            stmt.setString(1,roomId);stmt.setInt(2,stage);
            try(var rows=stmt.executeQuery()){return rows.next()?rows.getInt(1):0;}
        }
    }

    private static Match match(Connection conn,String roomId)throws SQLException {
        try(var stmt=conn.prepareStatement("""
            SELECT stage,roster_size,duration_seconds,stage_started_at,state
            FROM game_room_telephone_match WHERE room_id=?
            """)) {
            stmt.setString(1,roomId);
            try(var rows=stmt.executeQuery()){
                return rows.next()?new Match(rows.getInt(1),rows.getInt(2),
                    rows.getInt(3),rows.getString(4),rows.getString(5)):null;
            }
        }
    }

    private static String normalizeText(String input) {
        String value=input==null?"":input.trim();
        if(value.isEmpty()||value.length()>180)
            throw new IllegalArgumentException("text must be 1..180 characters");
        return value;
    }

    /** Bound each drawable point to a unit canvas; never store executable SVG. */
    private static String normalizeDrawing(String input) {
        if(input==null||input.length()>180_000)
            throw new IllegalArgumentException("drawing payload too large");
        JsonElement parsed;
        try{parsed=JsonParser.parseString(input);}
        catch(RuntimeException invalid){
            throw new IllegalArgumentException("invalid drawing",invalid);
        }
        if(!parsed.isJsonArray())throw new IllegalArgumentException("strokes array required");
        JsonArray inputStrokes=parsed.getAsJsonArray();
        if(inputStrokes.isEmpty()||inputStrokes.size()>100)
            throw new IllegalArgumentException("drawing strokes out of bounds");
        var output=new JsonArray();
        for(JsonElement part:inputStrokes) {
            if(!part.isJsonArray()||part.getAsJsonArray().isEmpty()
                ||part.getAsJsonArray().size()>96)
                throw new IllegalArgumentException("invalid stroke");
            var points=new JsonArray();
            for(JsonElement point:part.getAsJsonArray()){
                if(!point.isJsonObject())
                    throw new IllegalArgumentException("invalid point");
                JsonObject obj=point.getAsJsonObject();
                if(!obj.has("x")||!obj.has("y")
                    ||!obj.get("x").isJsonPrimitive()
                    ||!obj.get("y").isJsonPrimitive())
                    throw new IllegalArgumentException("invalid coordinates");
                double x,y;
                try{x=obj.get("x").getAsDouble();y=obj.get("y").getAsDouble();}
                catch(RuntimeException invalid){throw new IllegalArgumentException(
                    "invalid point numeric value",invalid);}
                if(!Double.isFinite(x)||!Double.isFinite(y)
                    ||x<0||x>1||y<0||y>1)
                    throw new IllegalArgumentException("point outside canvas");
                JsonObject clean=new JsonObject();
                clean.addProperty("x",x);clean.addProperty("y",y);
                points.add(clean);
            }
            output.add(points);
        }
        return output.toString();
    }

    private static boolean connected(Room room,String id){
        return room.members().stream().anyMatch(m->m.memberId().equals(id)
            && m.status()==MemberStatus.JOINED);
    }
    private static void drawing(Room room) {
        if(!"drawing_guess".equals(room.gameId()))
            throw new GameRoomService.RoomConflict("not a Drawing room");
    }
}
