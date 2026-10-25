package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.time.Duration;

/** R13d: host-controlled reveal cursor, spectators follow, durable reconnect. */
public final class GameRoomTelephonePresenterR13dProbe {
    private static int checks;
    private GameRoomTelephonePresenterR13dProbe(){}

    public static void main(String[] args)throws Exception {
        var root=Files.createTempDirectory("telephone-presenter-r13d-");
        try {
            var file=root.resolve("room.db");
            var db=new BoardGameDatabase(file);
            db.initialize();
            var access=new GameRoomAccessService(db);
            var game=new GameRoomTelephoneService(db,access);
            var hosted=access.createHostedRoom("drawing_guess","Presenter",
                "Host",SeatRole.PLAYER,3,5);
            String host=hosted.hostCredential().token();
            var b=access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofMinutes(15)).token(),"Alice");
            var c=access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofMinutes(15)).token(),"Bob");
            var watcher=access.join(access.invite(host,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(15)).token(),"Watching");
            access.ready(host,true);access.ready(b.token(),true);
            access.ready(c.token(),true);
            var open=game.start(host,120,GameRoomTelephoneService.Mode.NORMAL);
            check(open.presentation()==null,
                "no presentation data or albums before reveal");
            conflict(()->game.present(host,0,0,0),
                "cannot expose album cursor during an active game");
            forbidden(()->game.present(watcher.token(),0,0,0),
                "spectator cannot control private reveal");
            String[] seats={host,b.token(),c.token()};
            for(int turn=0;turn<3;turn++){
                for(int member=0;member<3;member++){
                    if(turn%2==0)
                        game.submit(seats[member],turn,"text "+turn+member,null);
                    else
                        game.submit(seats[member],turn,null,
                            "[[{\"x\":0.2,\"y\":0.4}]]");
                }
            }
            var reveal=game.state(host);
            check("REVEAL".equals(reveal.state())
                && reveal.presentation().albumIndex()==0
                && reveal.presentation().stepIndex()==0
                && reveal.presentation().revision()==0,
                "first album and first slide are authoritative default");
            check(game.state(watcher.token()).albums().size()==3,
                "spectator sees published albums once game is complete");
            forbidden(()->game.present(b.token(),0,1,0),
                "ordinary participant cannot drive reveal");
            forbidden(()->game.present(watcher.token(),0,1,0),
                "spectator cannot drive reveal");
            invalid(()->game.present(host,-1,1,0),
                "negative album rejected");
            invalid(()->game.present(host,3,0,0),
                "album beyond player roster rejected");
            invalid(()->game.present(host,0,-1,0),
                "negative step rejected");
            invalid(()->game.present(host,0,3,0),
                "step beyond album bounds rejected");
            var second=game.present(host,0,1,0);
            check(second.presentation().revision()==1
                && second.presentation().stepIndex()==1,
                "host advances authoritative slide atomically");
            check(game.state(b.token()).presentation().stepIndex()==1
                && game.state(watcher.token()).presentation().revision()==1,
                "players and observers follow the same position");
            check(game.present(host,0,1,0).presentation().revision()==1,
                "duplicate command retry is idempotent");
            conflict(()->game.present(host,2,0,0),
                "stale command cannot replace newer reveal");
            var next=game.present(host,1,0,1);
            check(next.presentation().albumIndex()==1
                && next.presentation().stepIndex()==0
                && next.presentation().revision()==2,
                "changing albums resets to the selected first step");
            check(game.state(c.token()).presentation().albumIndex()==1,
                "another player observes album selection");
            var recoveredDb=new BoardGameDatabase(file);
            recoveredDb.initialize();
            var recoveredAccess=new GameRoomAccessService(recoveredDb);
            var restored=new GameRoomTelephoneService(recoveredDb,recoveredAccess);
            check(restored.state(b.token()).presentation().revision()==2
                && restored.state(b.token()).presentation().albumIndex()==1,
                "presenter position survives process and SQLite restart");
            check(restored.state(watcher.token()).presentation().stepIndex()==0,
                "observer reconnect receives exact current slide");
            var done=restored.present(host,2,2,2);
            check(done.presentation().revision()==3
                && done.presentation().stepIndex()==2,
                "host can move to final album slide after restart");
            check(restored.state(c.token()).albums().get(2).entries().size()==3,
                "original album history stays immutable");
            recoveredAccess.closeRoom(host);
            forbidden(()->restored.state(host),
                "revoked member session cannot read reveal");
            forbidden(()->restored.present(host,0,0,3),
                "revoked host credential cannot drive old room");
            System.out.println("GAME_ROOM_R13D_PRESENTER_PASSED checks="+checks+
                " ACL=host-only sync=room-members revision=fenced"+
                " idempotent=true restore=sqlite spectator=read-only");
        } finally {
            try(var walk=Files.walk(root)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }

    @FunctionalInterface private interface Action {void run()throws Exception;}
    private static void check(boolean yes,String label){
        checks++;if(!yes)throw new AssertionError(label);
    }
    private static void forbidden(Action task,String label)throws Exception{
        checks++;try{task.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError(label);
    }
    private static void conflict(Action task,String label)throws Exception{
        checks++;try{task.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError(label);
    }
    private static void invalid(Action task,String label)throws Exception{
        checks++;try{task.run();}catch(IllegalArgumentException expected){return;}
        throw new AssertionError(label);
    }
}
