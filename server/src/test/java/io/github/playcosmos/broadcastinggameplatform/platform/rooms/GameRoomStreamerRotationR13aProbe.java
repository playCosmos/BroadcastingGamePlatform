package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;

/** R13a: bound SOOP streams map to authenticated player seats, frozen on start. */
public final class GameRoomStreamerRotationR13aProbe {
    private static int checks;
    private GameRoomStreamerRotationR13aProbe(){}

    public static void main(String[] args)throws Exception {
        var dir=Files.createTempDirectory("drawing-streamer-r13a-");
        try {
            var file=dir.resolve("state.db");
            var db=new BoardGameDatabase(file);
            db.initialize();
            var access=new GameRoomAccessService(db);
            var repository=new DrawingGuessRepository(db);
            var sync=new DrawingSyncService(db);
            var game=new DrawingGuessGameService(repository,sync);
            var drawing=new GameRoomDrawingService(db,access,repository,game,sync,
                (code,event)->{},source->"SOOP".equals(source.provider()));
            var hosted=access.createHostedRoom("drawing_guess","Streamers",
                "Streamer One",SeatRole.PLAYER,4,6);
            String host=hosted.hostCredential().token(),room=hosted.room().roomId();
            String hostId=hosted.hostCredential().memberId();
            var nonDrawer=access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofMinutes(30)).token(),"Viewer Player");
            var second=access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofMinutes(30)).token(),"Streamer Two");
            var watcher=access.join(access.invite(host,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(30)).token(),"Watching");
            forbidden(()->drawing.streamerAssignments(watcher.token()),
                "spectator cannot list streamer player association");
            forbidden(()->drawing.assignStreamer(nonDrawer.token(),"SOOP",
                "channel-one",hostId),"nonhost cannot assign streamers");
            conflict(()->drawing.assignStreamer(host,"SOOP",
                "unapproved",hostId),"only authorized broadcaster may be mapped");

            var firstGrant=drawing.issueChannelGrant(room,"SOOP",
                "channel-one",600).grant();
            var secondGrant=drawing.issueChannelGrant(room,"SOOP",
                "channel-two",600).grant();
            drawing.addChannel(host,"SOOP","channel-one",firstGrant);
            drawing.addChannel(host,"SOOP","channel-two",secondGrant);
            forbidden(()->drawing.assignStreamer(host,"SOOP","channel-one",
                watcher.memberId()),"spectator cannot become drawer");
            check(drawing.assignStreamer(host,"SOOP","channel-one",hostId)
                .size()==1,"first verified channel mapped to host PLAYER");
            check(drawing.assignStreamer(host,"SOOP","channel-two",second.memberId())
                .size()==2,"second verified channel mapped to player");
            check(drawing.streamerAssignments(host).stream().allMatch(x->
                x.memberId().equals(hostId)||x.memberId().equals(second.memberId())),
                "only GameRoom member IDs, never arbitrary provider users");
            access.ready(host,true);
            access.ready(nonDrawer.token(),true);
            access.ready(second.token(),true);
            invalid(()->drawing.start(host,DrawerPolicy.STREAMER_DRAWER,
                2,180,true),"legacy fixed streamer cannot use new rotation flag");
            var match=drawing.start(host,DrawerPolicy.ROTATING_DRAWER,2,180,true);
            check(match.streamerRotation() && match.nativeRoomId()!=null,
                "opt-in streamer rotation stored in game-room snapshot");
            check(match.nextDrawerMemberId().equals(hostId),
                "first selected streamer receives opening round");
            var nativeRoom=repository.findRoomBySourceRoom(room);
            check(nativeRoom.participants().stream().filter(x->x.canDraw())
                .map(x->x.participantId()).toList()
                .equals(List.of(hostId,second.memberId())),
                "only explicitly assigned players are frozen as native drawers");
            check(drawing.start(host,DrawerPolicy.ROTATING_DRAWER,2,180,true)
                .game().activeMatch().matchId()
                .equals(match.game().activeMatch().matchId()),
                "identical retry resumes existing match");
            conflict(()->drawing.start(host,DrawerPolicy.ROTATING_DRAWER,
                2,180,false),"cannot change frozen streamer rotation flag");
            conflict(()->drawing.assignStreamer(host,"SOOP","channel-one",
                nonDrawer.memberId()),"host cannot rewrite association mid-match");
            forbidden(()->drawing.startRound(nonDrawer.token(),
                "spoof","lemon",List.of()),"nonselected player cannot author round");
            var roundOne=drawing.startRound(host,"r13a-one","lemon",List.of());
            check(roundOne.canDraw(),"selected streamer can draw first round");
            forbidden(()->drawing.myPrompt(nonDrawer.token()),
                "nonselected player cannot recover secret");
            forbidden(()->drawing.draw(nonDrawer.token(),
                "{\"type\":\"canvas.clear\",\"payload\":{}}"),
                "nonselected player cannot write canvas");
            check(drawing.draw(host,
                "{\"type\":\"canvas.clear\",\"payload\":{}}")
                .json().contains("canvas.clear"),
                "selected streamer has native authorized canvas access");
            drawing.completeRound(host);
            check(drawing.state(second.token()).nextDrawerMemberId()
                .equals(second.memberId()),"next selected streamer receives round two");
            forbidden(()->drawing.startRound(nonDrawer.token(),"spoof",
                "orange",List.of()),"ordinary player cannot take streamer turn");
            // Revoking a feed stops its chat immediately but must not silently
            // reassign the already frozen drawing turns.
            drawing.removeChannel(host,"SOOP","channel-two");
            check(drawing.state(second.token()).nextDrawerMemberId()
                .equals(second.memberId()),
                "channel removal does not mutate existing immutable drawer order");
            access.disconnect(second.token(),Duration.ofMinutes(1));
            forbidden(()->drawing.startRound(second.token(),"disconnected",
                "orange",List.of()),"offline streamer cannot start drawing");
            access.reconnect(second.token());
            var roundTwo=drawing.startRound(second.token(),
                "r13a-two","orange",List.of());
            check(roundTwo.canDraw() && roundTwo.game().activeRound()
                .drawerParticipantId().equals(second.memberId()),
                "reconnected streamer recovers correct frozen turn");
            forbidden(()->drawing.myPrompt(host),
                "previous drawer cannot read next streamer's answer");
            var reopened=new BoardGameDatabase(file);
            reopened.initialize();
            var recovery=new GameRoomDrawingService(reopened,
                new GameRoomAccessService(reopened),
                new DrawingGuessRepository(reopened),
                new DrawingGuessGameService(new DrawingGuessRepository(reopened),
                    new DrawingSyncService(reopened)),
                new DrawingSyncService(reopened),(code,event)->{},
                source->"SOOP".equals(source.provider()));
            check(recovery.state(second.token()).streamerRotation()
                && recovery.state(second.token()).canDraw(),
                "current streamer authorization survives SQLite restart");
            recovery.completeRound(second.token());
            check(recovery.finish(host).room().state().name().equals("POST_GAME"),
                "room completes fixed streamer rotation cleanly");
            System.out.println("GAME_ROOM_R13A_STREAMER_ROTATION_PASSED checks="+checks+
                " frozen=sqlite bound_provider=SOOP drawer_acl=member"+
                " reconnect=verified legacy=untouched");
        } finally {
            try(var walk=Files.walk(dir)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }
    @FunctionalInterface private interface Action{void run()throws Exception;}
    private static void forbidden(Action action,String label)throws Exception{
        checks++;
        try{action.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError(label);
    }
    private static void conflict(Action action,String label)throws Exception{
        checks++;
        try{action.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError(label);
    }
    private static void invalid(Action action,String label)throws Exception{
        checks++;
        try{action.run();}catch(IllegalArgumentException expected){return;}
        throw new AssertionError(label);
    }
    private static void check(boolean ok,String label){
        checks++;if(!ok)throw new AssertionError(label);
    }
}
