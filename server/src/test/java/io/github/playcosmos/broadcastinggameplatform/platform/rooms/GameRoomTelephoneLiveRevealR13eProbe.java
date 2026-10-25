package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import com.google.gson.JsonParser;
import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/** R13e: versioned, post-commit room WebSocket cues and durable replay. */
public final class GameRoomTelephoneLiveRevealR13eProbe {
    private static int checks;
    private GameRoomTelephoneLiveRevealR13eProbe(){}

    public static void main(String[] args)throws Exception {
        var folder=Files.createTempDirectory("telephone-live-r13e-");
        try{
            var db=new BoardGameDatabase(folder.resolve("game.db"));
            db.initialize();
            var access=new GameRoomAccessService(db);
            var telephone=new GameRoomTelephoneService(db,access);
            List<String> sent=new ArrayList<>();
            var realtime=new GameRoomRealtimeService(db,access,
                (room,json)->sent.add(json));
            var hosted=access.createHostedRoom("drawing_guess","Live",
                "Host",SeatRole.PLAYER,3,4);
            String a=hosted.hostCredential().token();
            String roomId=hosted.room().roomId();
            var p2=access.join(access.invite(a,SeatRole.PLAYER,1,
                Duration.ofMinutes(15)).token(),"Second");
            var p3=access.join(access.invite(a,SeatRole.PLAYER,1,
                Duration.ofMinutes(15)).token(),"Third");
            var guest=access.join(access.invite(a,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(15)).token(),"Watching");
            String b=p2.token(),c=p3.token(),v=guest.token();
            access.ready(a,true);access.ready(b,true);access.ready(c,true);
            telephone.start(a,90);
            invalid(()->realtime.announceTelephonePresentation(a,0),
                "revision zero cannot broadcast before public reveal");
            check(realtime.events(v,0).events().isEmpty(),
                "no telephone reveal event before match completion");
            String[] members={a,b,c};
            for(int stage=0;stage<3;stage++)
                for(String token:members)
                    telephone.submit(token,stage,
                        stage%2==0?"stage "+stage:null,
                        stage%2==1?"[[{\"x\":0.3,\"y\":0.2}]]":null);
            check(telephone.state(v).presentation().revision()==0,
                "reveal initially has revision zero");
            var change=telephone.present(a,1,0,0);
            var first=realtime.announceTelephonePresentation(a,
                change.presentation().revision());
            check(first!=null && "room.telephone.presentation".equals(first.type())
                && roomId.equals(first.roomId()) && first.sequence()>0,
                "presenter cue is a canonical room event");
            check(sent.size()==1 && sent.get(0).contains(
                "room.telephone.presentation"),
                "connected room subscribers receive exactly one broadcast");
            var fields=JsonParser.parseString(first.text()).getAsJsonObject();
            check(fields.get("albumIndex").getAsInt()==1
                && fields.get("stepIndex").getAsInt()==0
                && fields.get("revision").getAsLong()==1,
                "WS notification carries only public canonical revision cursor");
            var replay=realtime.events(v,0);
            check(replay.events().size()==1
                && replay.events().getFirst().sequence()==first.sequence(),
                "spectator can replay same committed room event on reconnect");
            check(realtime.announceTelephonePresentation(a,1).sequence()
                ==first.sequence() && sent.size()==1,
                "retry does not persist or rebroadcast duplicate presentation");
            forbidden(()->realtime.announceTelephonePresentation(b,1),
                "ordinary player cannot forge a room presentation cue");
            forbidden(()->realtime.announceTelephonePresentation(v,1),
                "spectator cannot forge a room presentation cue");
            var next=telephone.present(a,1,1,1);
            check(realtime.announceTelephonePresentation(a,1)==null,
                "stale previously committed revision cannot emit out of order");
            var second=realtime.announceTelephonePresentation(a,
                next.presentation().revision());
            check(second!=null && second.sequence()>first.sequence()
                && sent.size()==2,
                "a newer committed step broadcasts strictly after older event");
            var restartedDb=new BoardGameDatabase(folder.resolve("game.db"));
            restartedDb.initialize();
            var restartedAccess=new GameRoomAccessService(restartedDb);
            var restartedRealtime=new GameRoomRealtimeService(restartedDb,
                restartedAccess,(room,json)->{});
            check(restartedRealtime.events(v,first.sequence()).events()
                .getFirst().messageId().equals("telephone-reveal-2"),
                "missed WebSocket message can replay after process restart");
            check(new GameRoomTelephoneService(restartedDb,restartedAccess)
                .state(v).presentation().revision()==2,
                "REST snapshot is authoritative after socket disconnect");
            restartedAccess.closeRoom(a);
            forbidden(()->restartedRealtime.events(v,0),
                "kicked/closed room tokens cannot replay a revealed event");
            forbidden(()->restartedRealtime.announceTelephonePresentation(a,2),
                "revoked host cannot announce even already published revisions");
            System.out.println("GAME_ROOM_R13E_LIVE_REVEAL_PASSED checks="+checks+
                " roomEvent=persisted afterCommit=true retry=deduplicated"+
                " order=revision replay=sqlite guest=read-only");
        }finally{
            try(var walk=Files.walk(folder)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }
    @FunctionalInterface private interface Action {void run()throws Exception;}
    private static void check(boolean yes,String title){
        checks++;if(!yes)throw new AssertionError(title);
    }
    private static void forbidden(Action task,String title)throws Exception{
        checks++;try{task.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError(title);
    }
    private static void invalid(Action task,String title)throws Exception{
        checks++;try{task.run();}catch(IllegalArgumentException expected){return;}
        throw new AssertionError(title);
    }
}
