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
import java.time.Duration;
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
    public enum Mode { NORMAL, COOP }
    public record AlbumEntry(int stage,String kind,String content,String author) {}
    public record Album(String originalAuthor,List<AlbumEntry> entries) {}
    public record Presentation(int albumIndex,int stepIndex,long revision) {}
    public record Playback(boolean playing,int intervalSeconds,String nextAt) {}
    public record View(boolean active,String state,int stage,int stages,int seconds,
                       String stageStartedAt,int submitted,int participants,
                       String taskKind,String previousKind,String previousContent,
                       boolean mySubmitted,List<Album> albums,Mode mode,
                       Presentation presentation,Playback playback,
                       String serverNow) {}
    private record Match(int stage,int size,int seconds,String started,String state,
                         Mode mode,Presentation presentation,Playback playback) {}
    private record Slot(int order,String memberId,String name) {}

    private final GameRoomService rooms;
    private final GameRoomAccessService access;

    public GameRoomTelephoneService(DatabaseAccess database,GameRoomAccessService access) {
        rooms=new GameRoomService(Objects.requireNonNull(database));
        this.access=Objects.requireNonNull(access);
    }

    public View start(String hostToken,int seconds)throws SQLException {
        return start(hostToken,seconds,Mode.NORMAL);
    }

    public View start(String hostToken,int seconds,Mode mode)throws SQLException {
        Objects.requireNonNull(mode,"mode");
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
                if(existing.seconds()!=seconds || existing.mode()!=mode)
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
                  room_id,stage,roster_size,duration_seconds,stage_started_at,state,mode)
                VALUES(?,0,?,?,?,'PLAYING',?)
                """)) {
                add.setString(1,room.roomId());add.setInt(2,players.size());
                add.setInt(3,seconds);add.setString(4,now);
                add.setString(5,mode.name());add.executeUpdate();
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
                0,0,null,null,null,false,List.of(),Mode.NORMAL,null,null,
                Instant.now().toString());
            advanceExpired(conn,room,match);
            advancePlayback(conn,room.roomId(),match(conn,room.roomId()));
            return view(conn,GameRoomService.read(conn,room.roomId()),
                principal.memberId(),match(conn,room.roomId()));
        });
    }

    /**
     * Connected host advances the shared reveal cursor. The expected revision
     * fences stale browser commands, while identical retries are idempotent.
     * Room members may observe but can never change the presented frame.
     */
    public View present(String token,int albumIndex,int stepIndex,long expectedRevision)
        throws SQLException {
        return rooms.write(conn->{
            var principal=access.requireSession(conn,token);
            Room room=GameRoomService.read(conn,principal.roomId());
            drawing(room);
            if(!principal.isHost() || !connected(room,principal.memberId()))
                throw new GameRoomAccessService.Forbidden(
                    "connected host required for album presentation");
            Match match=match(conn,room.roomId());
            if(match==null || !"REVEAL".equals(match.state()))
                throw new GameRoomService.RoomConflict(
                    "album presentation requires completed game");
            if(albumIndex<0 || albumIndex>=match.size() ||
                stepIndex<0 || stepIndex>=match.size())
                throw new IllegalArgumentException("album cursor out of range");
            if(match.playback().playing())
                throw new GameRoomService.RoomConflict(
                    "pause automatic slideshow before manual navigation");
            Presentation old=match.presentation();
            boolean same=old.albumIndex()==albumIndex &&
                old.stepIndex()==stepIndex;
            if(same) return view(conn,room,principal.memberId(),match);
            if(expectedRevision!=old.revision())
                throw new GameRoomService.RoomConflict("stale album presentation");
            try(var stmt=conn.prepareStatement("""
                UPDATE game_room_telephone_match
                SET reveal_album=?,reveal_step=?,reveal_revision=reveal_revision+1
                WHERE room_id=? AND state='REVEAL' AND reveal_revision=?
                """)) {
                stmt.setInt(1,albumIndex);
                stmt.setInt(2,stepIndex);
                stmt.setString(3,room.roomId());
                stmt.setLong(4,expectedRevision);
                if(stmt.executeUpdate()!=1)
                    throw new GameRoomService.RoomConflict(
                        "album presentation changed concurrently");
            }
            return view(conn,room,principal.memberId(),match(conn,room.roomId()));
        });
    }

    /**
     * Host-controlled playback state. The server clock owns progression,
     * including reconciliation across suspension and app restarts.
     * PLAY from the last slide restarts at the beginning; PAUSE freezes the
     * exact authoritative slide; SPEED changes the next interval.
     */
    public View playback(String token,String action,int intervalSeconds,
                         long expectedRevision)throws SQLException {
        if(!List.of("PLAY","PAUSE","SPEED").contains(action))
            throw new IllegalArgumentException("invalid playback command");
        if(intervalSeconds<3 || intervalSeconds>20)
            throw new IllegalArgumentException("playback speed must be 3..20 seconds");
        return rooms.write(conn->{
            var principal=access.requireSession(conn,token);
            Room room=GameRoomService.read(conn,principal.roomId());
            drawing(room);
            if(!principal.isHost() || !connected(room,principal.memberId()))
                throw new GameRoomAccessService.Forbidden("connected host required");
            Match match=match(conn,room.roomId());
            if(match==null || !"REVEAL".equals(match.state()))
                throw new GameRoomService.RoomConflict(
                    "playback only available after complete reveal");
            // Materialize overdue clock ticks BEFORE validating a browser
            // command so a delayed tablet cannot pause an earlier slide.
            advancePlayback(conn,room.roomId(),match);
            match=match(conn,room.roomId());
            var old=match.presentation();
            var current=match.playback();
            boolean unchanged=("PAUSE".equals(action)&&!current.playing())
                ||("SPEED".equals(action)&&intervalSeconds==current.intervalSeconds())
                ||("PLAY".equals(action)&&current.playing()
                    && intervalSeconds==current.intervalSeconds());
            if(unchanged)return view(conn,room,principal.memberId(),match);
            if(expectedRevision!=old.revision())
                throw new GameRoomService.RoomConflict("stale playback revision");
            boolean playing=current.playing();
            int speed=current.intervalSeconds();
            int album=old.albumIndex(),step=old.stepIndex();
            String nextAt=current.nextAt();
            switch(action){
                case "PLAY" -> {
                    speed=intervalSeconds;
                    playing=true;
                    if(album==match.size()-1 && step==match.size()-1){
                        album=0;step=0;
                    }
                    nextAt=Instant.now().plusSeconds(speed).toString();
                }
                case "PAUSE" -> {
                    playing=false;
                    nextAt=null;
                }
                case "SPEED" -> {
                    speed=intervalSeconds;
                    if(playing)
                        nextAt=Instant.now().plusSeconds(speed).toString();
                }
                default -> throw new IllegalArgumentException("invalid playback");
            }
            try(var update=conn.prepareStatement("""
                UPDATE game_room_telephone_match
                SET reveal_album=?,reveal_step=?,
                    reveal_revision=reveal_revision+1,
                    reveal_playing=?,reveal_interval_seconds=?,reveal_next_at=?
                WHERE room_id=? AND state='REVEAL' AND reveal_revision=?
                """)){
                update.setInt(1,album);update.setInt(2,step);
                update.setInt(3,playing?1:0);update.setInt(4,speed);
                update.setString(5,nextAt);update.setString(6,room.roomId());
                update.setLong(7,old.revision());
                if(update.executeUpdate()!=1)
                    throw new GameRoomService.RoomConflict("playback changed");
            }
            return view(conn,room,principal.memberId(),
                match(conn,room.roomId()));
        });
    }

    /** Time-driven progression: no per-room threads or browser-owned timer. */
    private static void advancePlayback(Connection conn,String roomId,Match match)
        throws SQLException {
        if(match==null || !"REVEAL".equals(match.state())
            || !match.playback().playing())return;
        String deadline=match.playback().nextAt();
        if(deadline==null)throw new GameRoomService.RoomConflict(
            "active slideshow missing deadline");
        Instant due=Instant.parse(deadline);
        Instant now=Instant.now();
        if(now.isBefore(due))return;
        int speed=match.playback().intervalSeconds();
        long elapsed=Duration.between(due,now).getSeconds();
        long ticks=1+elapsed/speed;
        var old=match.presentation();
        int size=match.size();
        long index=(long)old.albumIndex()*size+old.stepIndex();
        long last=(long)size*size-1;
        long advanced=Math.min(ticks,last-index);
        boolean continuing=index+advanced<last;
        long next=index+advanced;
        try(var update=conn.prepareStatement("""
            UPDATE game_room_telephone_match
            SET reveal_album=?,reveal_step=?,
                reveal_revision=reveal_revision+?,
                reveal_playing=?,reveal_next_at=?
            WHERE room_id=? AND reveal_revision=? AND state='REVEAL'
            """)){
            update.setInt(1,(int)(next/size));
            update.setInt(2,(int)(next%size));
            update.setLong(3,Math.max(1,advanced));
            update.setInt(4,continuing?1:0);
            update.setString(5,continuing?
                due.plusSeconds(ticks*speed).toString():null);
            update.setString(6,roomId);
            update.setLong(7,old.revision());
            if(update.executeUpdate()!=1)
                throw new GameRoomService.RoomConflict("playback tick conflict");
        }
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
            boolean drawing=match.mode()==Mode.COOP || match.stage()%2==1;
            String content;
            if(match.mode()==Mode.COOP) {
                // The client submits only NEW strokes. Previous authors'
                // content is read from SQLite and cannot be erased/replaced.
                String delta=normalizeDrawing(drawingJson,true);
                String inherited="[]";
                if(match.stage()>0) {
                    var before=entry(conn,room.roomId(),album,match.stage()-1);
                    if(before==null || !"DRAWING".equals(before.kind()))
                        throw new GameRoomService.RoomConflict(
                            "previous cooperative canvas unavailable");
                    inherited=before.content();
                }
                content=appendStrokes(inherited,delta);
            } else {
                content=drawing?normalizeDrawing(drawingJson):normalizeText(text);
            }
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
                boolean drawing=match.mode()==Mode.COOP || match.stage()%2==1;
                insert.setString(5,drawing?"DRAWING":"TEXT");
                String timeoutContent=drawing?"[]":"(시간 초과)";
                if(match.mode()==Mode.COOP && match.stage()>0) {
                    var predecessor=entry(conn,room.roomId(),album,match.stage()-1);
                    timeoutContent=predecessor==null?"[]":predecessor.content();
                }
                insert.setString(6,timeoutContent);
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
        String kind=!reveal?
            (m.mode()==Mode.COOP || m.stage()%2==1?"DRAWING":"TEXT"):null;
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
            submitted,reveal?albums(conn,room.roomId(),m.size()):List.of(),
            m.mode(),reveal?m.presentation():null,
            reveal?m.playback():null,Instant.now().toString());
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
            SELECT stage,roster_size,duration_seconds,stage_started_at,state,
                   mode,reveal_album,reveal_step,reveal_revision,
                   reveal_playing,reveal_interval_seconds,reveal_next_at
            FROM game_room_telephone_match WHERE room_id=?
            """)) {
            stmt.setString(1,roomId);
            try(var rows=stmt.executeQuery()){
                return rows.next()?new Match(rows.getInt(1),rows.getInt(2),
                    rows.getInt(3),rows.getString(4),rows.getString(5),
                    Mode.valueOf(rows.getString(6)),
                    new Presentation(rows.getInt(7),rows.getInt(8),
                        rows.getLong(9)),
                    new Playback(rows.getInt(10)==1,rows.getInt(11),
                        rows.getString(12))):null;
            }
        }
    }

    private static String normalizeText(String input) {
        String value=input==null?"":input.trim();
        if(value.isEmpty()||value.length()>180)
            throw new IllegalArgumentException("text must be 1..180 characters");
        return value;
    }

    /** Add only submitted strokes to the trusted previous snapshot. */
    private static String appendStrokes(String inherited,String delta) {
        JsonArray base=JsonParser.parseString(inherited).getAsJsonArray();
        JsonArray additions=JsonParser.parseString(delta).getAsJsonArray();
        if(base.size()+additions.size()>300)
            throw new IllegalArgumentException("cooperative drawing exceeds 300 strokes");
        for(JsonElement stroke:additions)base.add(stroke);
        String combined=base.toString();
        if(combined.length()>180_000)
            throw new IllegalArgumentException("cooperative canvas exceeds storage budget");
        return combined;
    }

    /** Bound each drawable point to a unit canvas; never store executable SVG. */
    private static String normalizeDrawing(String input) {
        return normalizeDrawing(input,false);
    }
    private static String normalizeDrawing(String input,boolean emptyAllowed) {
        if(input==null||input.length()>180_000)
            throw new IllegalArgumentException("drawing payload too large");
        JsonElement parsed;
        try{parsed=JsonParser.parseString(input);}
        catch(RuntimeException invalid){
            throw new IllegalArgumentException("invalid drawing",invalid);
        }
        if(!parsed.isJsonArray())throw new IllegalArgumentException("strokes array required");
        JsonArray inputStrokes=parsed.getAsJsonArray();
        if((inputStrokes.isEmpty()&&!emptyAllowed)||inputStrokes.size()>100)
            throw new IllegalArgumentException("drawing strokes out of bounds");
        var output=new JsonArray();
        for(JsonElement part:inputStrokes) {
            // Older sketches consisted of bare point arrays; preserve them.
            // New UX stores fixed-color strokes and a bounded pixel width.
            JsonObject style=part.isJsonObject()?part.getAsJsonObject():null;
            JsonElement payload=style==null?part:style.get("points");
            if(payload==null||!payload.isJsonArray()
                ||payload.getAsJsonArray().isEmpty()
                ||payload.getAsJsonArray().size()>96)
                throw new IllegalArgumentException("invalid stroke");
            String color="#25374c";
            int width=4;
            if(style!=null) {
                if(style.has("color")) {
                    if(!style.get("color").isJsonPrimitive())
                        throw new IllegalArgumentException("invalid brush color");
                    color=style.get("color").getAsString();
                    if(!color.matches("#[0-9a-fA-F]{6}"))
                        throw new IllegalArgumentException("invalid brush color");
                }
                if(style.has("width")) {
                    if(!style.get("width").isJsonPrimitive())
                        throw new IllegalArgumentException("invalid brush width");
                    double raw;
                    try{raw=style.get("width").getAsDouble();}
                    catch(RuntimeException invalid){
                        throw new IllegalArgumentException("invalid brush width",invalid);
                    }
                    if(!Double.isFinite(raw)||raw!=Math.floor(raw)||raw<1||raw>24)
                        throw new IllegalArgumentException("brush width outside 1..24");
                    width=(int)raw;
                }
            }
            var points=new JsonArray();
            for(JsonElement point:payload.getAsJsonArray()){
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
            JsonObject canonical=new JsonObject();
            canonical.add("points",points);
            canonical.addProperty("color",color.toLowerCase(java.util.Locale.ROOT));
            canonical.addProperty("width",width);
            output.add(canonical);
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
