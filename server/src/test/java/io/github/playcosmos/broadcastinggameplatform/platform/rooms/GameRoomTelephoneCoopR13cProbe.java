package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;

/** R13c: immutable collaborative canvas, n-way routing and slide-ready history. */
public final class GameRoomTelephoneCoopR13cProbe {
    private static int checks;
    private GameRoomTelephoneCoopR13cProbe() {}

    public static void main(String[] args)throws Exception {
        var root=Files.createTempDirectory("telephone-coop-r13c-");
        try {
            var file=root.resolve("room.db");
            var db=new BoardGameDatabase(file);db.initialize();
            var access=new GameRoomAccessService(db);
            var service=new GameRoomTelephoneService(db,access);
            var host=access.createHostedRoom("drawing_guess","Coop drawing",
                "Drawer A",SeatRole.PLAYER,4,5);
            String a=host.hostCredential().token(),id=host.room().roomId();
            var next=access.join(access.invite(a,SeatRole.PLAYER,1,
                Duration.ofMinutes(15)).token(),"Drawer B");
            var third=access.join(access.invite(a,SeatRole.PLAYER,1,
                Duration.ofMinutes(15)).token(),"Drawer C");
            var spectator=access.join(access.invite(a,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(15)).token(),"Spectator");
            String b=next.token(),c=third.token(),v=spectator.token();
            access.ready(a,true);access.ready(b,true);access.ready(c,true);
            var opened=service.start(a,90,GameRoomTelephoneService.Mode.COOP);
            check(opened.active() && opened.mode()==GameRoomTelephoneService.Mode.COOP
                && opened.stage()==0 && "DRAWING".equals(opened.taskKind()),
                "coop starts with DRAWING, not writing");
            check(opened.previousContent()==null,"stage 0 has no base");
            conflict(()->service.start(a,90,GameRoomTelephoneService.Mode.NORMAL),
                "room mode is frozen after startup");
            forbidden(()->service.submit(v,0,null,"[]"),
                "spectator cannot submit own or other artists' work");
            invalid(()->service.submit(a,0,"not used","{\"bad\":true}"),
                "malformed stroke JSON fails closed");
            String first="[{#}]".replace("{#}",
                "{\"points\":[{\"x\":0.1,\"y\":0.2}],\"color\":\"#102030\",\"width\":3}");
            String second="[{#}]".replace("{#}",
                "{\"points\":[{\"x\":0.3,\"y\":0.4}],\"color\":\"#abcdef\",\"width\":6}");
            String thirdStroke="[{#}]".replace("{#}",
                "{\"points\":[{\"x\":0.5,\"y\":0.6}],\"color\":\"#445566\",\"width\":12}");
            check(service.submit(a,0,null,first).mySubmitted(),
                "first local stroke set recorded privately");
            conflict(()->service.submit(a,0,null,second),
                "same connected member cannot overwrite accepted submission");
            check(service.state(v).previousContent()==null
                && service.state(v).albums().isEmpty(),
                "spectator cannot see current cooperative strokes or albums");
            service.submit(b,0,null,first);
            var step1=service.submit(c,0,null,first);
            check(step1.stage()==1 && step1.mode()==GameRoomTelephoneService.Mode.COOP,
                "three independent drawing chains advance together");
            check(service.state(a).previousKind().equals("DRAWING")
                && service.state(a).previousContent().contains("#102030"),
                "only the correct predecessor snapshot is returned");
            check(service.state(a).albums().isEmpty(),
                "midgame album content remains private");
            conflict(()->service.submit(b,0,null,second),
                "stale turn cannot be submitted into a new phase");
            String original=service.state(a).previousContent();
            service.submit(a,1,null,second);
            service.submit(b,1,null,second);
            service.submit(c,1,null,second);
            var phase2=service.state(a);
            check(phase2.stage()==2 && phase2.previousContent().contains("#abcdef"),
                "second phase appends colored strokes");
            var cumulative=JsonParser.parseString(phase2.previousContent())
                .getAsJsonArray();
            check(cumulative.size()==2
                && cumulative.get(0).getAsJsonObject().get("color")
                    .getAsString().equals("#102030")
                && cumulative.get(1).getAsJsonObject().get("color")
                    .getAsString().equals("#abcdef"),
                "previous canvas is preserved and deltas append atomically");
            check(original.contains("#102030"),"inherited snapshot remained unchanged");
            var reopened=new BoardGameDatabase(file);reopened.initialize();
            var recovered=new GameRoomTelephoneService(reopened,
                new GameRoomAccessService(reopened));
            check(recovered.state(a).mode()==GameRoomTelephoneService.Mode.COOP
                && recovered.state(a).stage()==2,
                "cooperative mode and phase survive SQLite restart");
            // Blank delta means preserve the predecessor without altering it.
            recovered.submit(a,2,null,"[]");
            recovered.submit(b,2,null,thirdStroke);
            var revealed=recovered.submit(c,2,null,thirdStroke);
            check(revealed.state().equals("REVEAL")
                && revealed.albums().size()==3,"all albums unlock together");
            check(revealed.albums().stream().allMatch(album->
                album.entries().size()==3
                && album.entries().stream().allMatch(entry->
                    entry.kind().equals("DRAWING"))),
                "gallery presents all cooperative phases as drawings");
            check(revealed.albums().stream().allMatch(album->
                JsonParser.parseString(album.entries().get(1).content())
                    .getAsJsonArray().size()==2),
                "every album has exactly two strokes at second stage");
            check(revealed.albums().stream().allMatch(album->
                JsonParser.parseString(album.entries().get(2).content())
                    .getAsJsonArray().size()>=2),
                "last snapshots preserve all earlier strokes");
            check(recovered.state(v).albums().size()==3,
                "spectator gets album only once reveal is complete");
            check(access.room(a).state().name().equals("POST_GAME"),
                "shared room returns to post-game on final slide");
            conflict(()->recovered.submit(a,2,null,thirdStroke),
                "reveal rejects delayed canvas replay");
            System.out.println("GAME_ROOM_R13C_COOP_PASSED checks="+checks+
                " mode=frozen stages=draw-only inherited=append-only"+
                " timeout=separate gallery=slides privacy=member sqlite=durable");
        } finally {
            try(var walk=Files.walk(root)){
                walk.sorted((x,y)->y.compareTo(x)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }
    @FunctionalInterface private interface Action{void run()throws Exception;}
    private static void check(boolean ok,String description){
        checks++;if(!ok)throw new AssertionError(description);
    }
    private static void forbidden(Action op,String description)throws Exception {
        checks++;try{op.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError(description);
    }
    private static void conflict(Action op,String description)throws Exception {
        checks++;try{op.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError(description);
    }
    private static void invalid(Action op,String description)throws Exception {
        checks++;try{op.run();}catch(IllegalArgumentException expected){return;}
        throw new AssertionError(description);
    }
}
