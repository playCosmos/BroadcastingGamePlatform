package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

/** R13b: three concurrent albums, alternating writing/drawing/guessing. */
public final class GameRoomTelephoneR13bProbe {
    private static int checks;
    private GameRoomTelephoneR13bProbe(){}

    public static void main(String[] args)throws Exception {
        var dir=Files.createTempDirectory("telephone-r13b-");
        try{
            var file=dir.resolve("room.db");
            var db=new BoardGameDatabase(file);db.initialize();
            var access=new GameRoomAccessService(db);
            var telephone=new GameRoomTelephoneService(db,access);
            var hosted=access.createHostedRoom("drawing_guess","Telephone",
                "Alice",SeatRole.PLAYER,4,6);
            String a=hosted.hostCredential().token(),room=hosted.room().roomId();
            var bob=access.join(access.invite(a,SeatRole.PLAYER,1,
                Duration.ofMinutes(10)).token(),"Bob");
            var carol=access.join(access.invite(a,SeatRole.PLAYER,1,
                Duration.ofMinutes(10)).token(),"Carol");
            var watcher=access.join(access.invite(a,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(10)).token(),"Viewer");
            String b=bob.token(),c=carol.token(),v=watcher.token();
            conflict(()->telephone.start(a,90),"unready players cannot start");
            forbidden(()->telephone.start(b,90),"nonhost cannot begin a match");
            invalid(()->telephone.start(a,20),"stage clock bounded");
            access.ready(a,true);access.ready(b,true);access.ready(c,true);
            var initial=telephone.start(a,90);
            check(initial.active() && initial.stage()==0 && initial.stages()==3,
                "three player albums reserved in one game-room");
            check(Math.abs(Duration.between(Instant.parse(initial.serverNow()),
                Instant.now()).toMillis())<5000,
                "every authorized telephone view carries a fresh server clock");
            check(Math.abs(Duration.between(
                Instant.parse(telephone.state(v).serverNow()),
                Instant.now()).toMillis())<5000,
                "anonymous spectator receives clock metadata without prompt");
            check("TEXT".equals(initial.taskKind()) &&
                initial.previousContent()==null,"first turn starts private text");
            check("PLAYING".equals(access.room(a).state().name()),
                "room enters active playing state");
            check(telephone.start(a,90).stage()==0,
                "identical host retry preserves all stage data");
            conflict(()->telephone.start(a,120),
                "cannot rewrite frozen timeout");
            forbidden(()->telephone.submit(v,"spectator cannot play",null),
                "observer cannot submit any prompt");

            check(telephone.submit(a,"A rainbow koala",null).mySubmitted(),
                "first member writes a private prompt");
            conflict(()->telephone.submit(a,"overwrite",null),
                "member cannot submit twice in one stage");
            check(telephone.state(b).previousContent()==null,
                "Bob cannot read other unsubmitted prompt");
            check(telephone.state(v).taskKind()==null
                && telephone.state(v).previousContent()==null,
                "spectator sees no hidden private task/answer");
            telephone.submit(b,"a glass train",null);
            var phase1=telephone.submit(c,"a red turtle",null);
            check(phase1.stage()==1 && "DRAWING".equals(phase1.taskKind()),
                "all ready members advance to drawing simultaneously");
            check("a red turtle".equals(telephone.state(a).previousContent()),
                "Alice sees predecessor Carol's phrase, not her own");
            check("A rainbow koala".equals(telephone.state(b).previousContent()),
                "Bob sees Alice's private phrase");
            check("a glass train".equals(telephone.state(c).previousContent()),
                "Carol sees Bob's private phrase");
            invalid(()->telephone.submit(a,"text in a draw turn",null),
                "drawing phase rejects text-only submission");
            invalid(()->telephone.submit(a,null,
                "[[{\"x\":-1,\"y\":0.5}]]"),"out-of-canvas points rejected");
            invalid(()->telephone.submit(a,null,
                "[{\"points\":[{\"x\":0.1,\"y\":0.2}],\"color\":\"javascript:alert(1)\"}]"),
                "only canonical hex colors may be persisted");
            invalid(()->telephone.submit(a,null,
                "[[{\"x\":0.1,\"y\":0.5,\"html\":\"<script>\"}],[1]]"),
                "malformed drawing rejected");
            String sketch="[[{\"x\":0.1,\"y\":0.2},{\"x\":0.7,\"y\":0.8}]]";
            telephone.submit(a,null,sketch);
            telephone.submit(b,null,sketch);
            var phase2=telephone.submit(c,null,sketch);
            check(phase2.stage()==2 && "TEXT".equals(phase2.taskKind()),
                "second transition reveals only predecessor drawing");
            check("DRAWING".equals(telephone.state(a).previousKind())
                && telephone.state(a).previousContent().contains("0.1"),
                "drawing is presented privately to its intended next author");
            check(telephone.state(v).previousContent()==null,
                "spectator cannot inspect in-flight sketch");
            telephone.submit(a,"a car?",null);
            telephone.submit(b,"turtle on a mountain?",null);
            var reveal=telephone.submit(c,"a spiral?",null);
            check("REVEAL".equals(reveal.state()) && reveal.albums().size()==3,
                "last turn shows three complete private albums");
            check(reveal.albums().stream().allMatch(x->x.entries().size()==3),
                "every album contains original phrase, drawing and guess");
            check(reveal.albums().get(0).entries().stream()
                .map(GameRoomTelephoneService.AlbumEntry::kind).toList()
                .equals(List.of("TEXT","DRAWING","TEXT")),
                "album timeline has expected telephone alternation");
            check(telephone.state(v).albums().size()==3,
                "spectators may see full gallery after official reveal");
            check("POST_GAME".equals(access.room(a).state().name()),
                "completed match returns GameRoom to post-game");
            conflict(()->telephone.submit(a,"late",null),
                "album is immutable after reveal");

            var restoredDb=new BoardGameDatabase(file);restoredDb.initialize();
            var restored=new GameRoomTelephoneService(restoredDb,
                new GameRoomAccessService(restoredDb));
            check(restored.state(c).albums().size()==3,
                "complete albums persist across server restart");
            access.closeRoom(a);
            forbidden(()->restored.state(a),
                "closed room revokes old bearer before viewing albums");

            // A separate match auto-advances on deadline without deadlocking
            // the chain when a writer disconnects or abandons their task.
            var newRoom=access.createHostedRoom("drawing_guess","Timed",
                "A",SeatRole.PLAYER,3,4);
            String x=newRoom.hostCredential().token();
            var y=access.join(access.invite(x,SeatRole.PLAYER,1,
                Duration.ofMinutes(5)).token(),"B");
            var z=access.join(access.invite(x,SeatRole.PLAYER,1,
                Duration.ofMinutes(5)).token(),"C");
            access.ready(x,true);access.ready(y.token(),true);access.ready(z.token(),true);
            telephone.start(x,30);
            try(var conn=db.open();var stmt=conn.prepareStatement("""
                UPDATE game_room_telephone_match
                SET stage_started_at='2001-01-01T00:00:00Z' WHERE room_id=?
                """)){
                stmt.setString(1,newRoom.room().roomId());stmt.executeUpdate();
            }
            check(telephone.state(x).stage()==1,
                "timeout automatically creates placeholders and advances stage");
            check(telephone.state(y.token()).previousContent().equals("(시간 초과)"),
                "next writer receives a bounded missing-artifact placeholder");

            System.out.println("GAME_ROOM_R13B_TELEPHONE_PASSED checks="+checks+
                " private_tasks=true concurrent_albums=3 atomic_stage=true"+
                " gallery=after_reveal timeout=recovered sqlite=durable");
        } finally {
            try(var walk=Files.walk(dir)) {
                walk.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }
    @FunctionalInterface private interface Action {void run()throws Exception;}
    private static void forbidden(Action a,String name)throws Exception {
        checks++;try{a.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError(name);
    }
    private static void conflict(Action a,String name)throws Exception {
        checks++;try{a.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError(name);
    }
    private static void invalid(Action a,String name)throws Exception {
        checks++;try{a.run();}catch(IllegalArgumentException expected){return;}
        throw new AssertionError(name);
    }
    private static void check(boolean ok,String name) {
        checks++;if(!ok)throw new AssertionError(name);
    }
}
