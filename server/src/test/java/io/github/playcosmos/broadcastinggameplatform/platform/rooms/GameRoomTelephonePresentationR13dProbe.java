package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;

/** R13d: authoritative post-reveal host presentation + read-only audience. */
public final class GameRoomTelephonePresentationR13dProbe {
    private static int checks;
    private GameRoomTelephonePresentationR13dProbe(){}

    public static void main(String[] args)throws Exception{
        var root=Files.createTempDirectory("r13d-presentation-");
        try{
            var file=root.resolve("room.db");
            var db=new BoardGameDatabase(file);
            db.initialize();
            var access=new GameRoomAccessService(db);
            var service=new GameRoomTelephoneService(db,access);
            var room=access.createHostedRoom("drawing_guess","Present",
                "Host",SeatRole.PLAYER,3,4);
            String host=room.hostCredential().token();
            var a=access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofMinutes(5)).token(),"Guest A");
            var b=access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofMinutes(5)).token(),"Guest B");
            var viewer=access.join(access.invite(host,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(5)).token(),"Viewer");
            String[] writers={host,a.token(),b.token()};
            for(String token:writers)access.ready(token,true);
            var start=service.start(host,60,GameRoomTelephoneService.Mode.COOP);
            check(start.presentation()==null,"no presentation cursor during match");
            conflict(()->service.present(host,0,true,0,0),
                "host cannot show incomplete albums to spectators");
            forbidden(()->service.present(viewer.token(),0,true,0,0),
                "spectators cannot start presentation");
            for(int stage=0;stage<3;stage++)
                for(String token:writers)service.submit(token,stage,null,"[]");
            var finished=service.state(host);
            check("REVEAL".equals(finished.state())
                && finished.presentation()!=null
                && !finished.presentation().enabled()
                && finished.presentation().revision()==0,
                "completed albums expose disabled revision-zero cursor");
            var first=service.present(host,0,true,1,0);
            check(first.presentation().enabled()
                && first.presentation().albumIndex()==1
                && first.presentation().stepIndex()==0
                && first.presentation().revision()==1,
                "host publishes first shared slide and advances revision");
            check(service.state(a.token()).presentation().albumIndex()==1,
                "second player receives shared host cursor");
            check(service.state(viewer.token()).presentation().enabled(),
                "spectator sees public cursor after official reveal");
            forbidden(()->service.present(a.token(),1,true,0,0),
                "joined player cannot control presentation");
            forbidden(()->service.present(viewer.token(),1,true,0,0),
                "spectator cannot change shared cursor");
            conflict(()->service.present(host,0,true,2,2),
                "stale browser tab cannot overwrite newer slide");
            invalid(()->service.present(host,1,true,4,0),
                "album indices must remain in frozen roster bounds");
            invalid(()->service.present(host,1,true,0,3),
                "step indices must remain in album bounds");
            var moved=service.present(host,1,true,1,2);
            check(moved.presentation().stepIndex()==2
                && moved.presentation().revision()==2,
                "host can atomically advance directly to next stage");
            var reopened=new BoardGameDatabase(file);
            reopened.initialize();
            var restored=new GameRoomTelephoneService(reopened,
                new GameRoomAccessService(reopened));
            check(restored.state(viewer.token()).presentation().stepIndex()==2
                && restored.state(viewer.token()).presentation().revision()==2,
                "viewer presentation recovers persisted cursor after restart");
            var stopped=restored.present(host,2,false,1,2);
            check(!stopped.presentation().enabled()
                && stopped.presentation().revision()==3,
                "host can stop broadcast without deleting albums");
            check(restored.state(a.token()).albums().size()==3,
                "local album browsing remains available after broadcast ends");
            check(restored.present(host,3,true,0,1).presentation().enabled(),
                "host can restart a shared slideshow");
            System.out.println("GAME_ROOM_R13D_PRESENTATION_PASSED checks="+checks+
                " host_acl=verified reveal_gate=true revision=cas"+
                " restart=durable audience=read_only legacy=preserved");
        }finally{
            try(var walk=Files.walk(root)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }
    @FunctionalInterface private interface Action{void run()throws Exception;}
    private static void check(boolean valid,String why){
        checks++;if(!valid)throw new AssertionError(why);
    }
    private static void conflict(Action action,String why)throws Exception{
        checks++;try{action.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError(why);
    }
    private static void forbidden(Action action,String why)throws Exception{
        checks++;try{action.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError(why);
    }
    private static void invalid(Action action,String why)throws Exception{
        checks++;try{action.run();}catch(IllegalArgumentException expected){return;}
        throw new AssertionError(why);
    }
}
