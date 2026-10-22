package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/** R5: full authenticated room-bound rotating & streamer round lifecycle. */
public final class GameRoomDrawingR5Probe {
    private static int checks;
    private GameRoomDrawingR5Probe(){}

    public static void main(String[] args) throws Exception {
        Path dir=Files.createTempDirectory("game-room-drawing-r5-");
        try {
            Path file=dir.resolve("game.db");
            var db=new BoardGameDatabase(file);
            db.initialize();
            var access=new GameRoomAccessService(db);
            var canvas=new DrawingSyncService(db);
            var repo=new DrawingGuessRepository(db);
            var game=new DrawingGuessGameService(repo,canvas);
            var published=new ArrayList<String>();
            var adapter=new GameRoomDrawingService(db,access,repo,game,canvas,
                (code,event)->published.add(code+"|"+event));
            var chat=new GameRoomRealtimeService(db,access,(id,json)->{});
            var hosted=access.createHostedRoom("drawing_guess",
                "Room-based drawing","Host",SeatRole.PLAYER,3,5);
            String host=hosted.hostCredential().token();
            String hostId=hosted.hostCredential().memberId();
            String roomId=hosted.room().roomId();
            var player=access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofHours(1)).token(),"Second");
            var viewer=access.join(access.invite(host,SeatRole.SPECTATOR,1,
                Duration.ofHours(1)).token(),"Viewer");
            check(adapter.state(host).nativeRoomId()==null,
                "no native game before host start");
            conflict(()->adapter.start(host,DrawerPolicy.ROTATING_DRAWER,2,120),
                "not all players ready");
            access.ready(host,true);
            access.ready(player.token(),true);
            forbidden(()->adapter.start(player.token(),DrawerPolicy.ROTATING_DRAWER,2,120),
                "only host may freeze player roster");
            var state=adapter.start(host,DrawerPolicy.ROTATING_DRAWER,2,120);
            check(state.game()!=null && state.game().activeMatch()!=null
                && state.game().activeMatch().totalRounds()==2,
                "R5 creates native match for ready players");
            check(state.room().playerCount()==2 && state.room().memberCount()==3,
                "player limit and overall membership count independent");
            check(repo.findRoomBySourceRoom(roomId).roomId().equals(state.nativeRoomId()),
                "native creation source key persisted atomically");
            String nativeId=state.nativeRoomId();
            String matchId=state.game().activeMatch().matchId();
            check(adapter.start(host,DrawerPolicy.ROTATING_DRAWER,2,120)
                .game().activeMatch().matchId().equals(matchId),
                "same host start is idempotent");
            conflict(()->adapter.start(host,DrawerPolicy.STREAMER_DRAWER,2,120),
                "cannot rewrite frozen drawer policy");
            conflict(()->adapter.start(host,DrawerPolicy.ROTATING_DRAWER,3,120),
                "cannot rewrite frozen match length");
            conflict(()->access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofMinutes(1)).token(),"Late"),
                "no midgame player admission");
            var extraViewer=access.join(access.invite(host,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(1)).token(),"Late Viewer");
            check(adapter.state(extraViewer.token()).room().memberCount()==4,
                "late spectator counts in overall room occupancy");

            forbidden(()->adapter.startRound(player.token(),"word01",
                "apple",List.of("apples")),"wrong drawer cannot start round 1");
            var first=adapter.startRound(host,"word01","apple",
                List.of("apples"));
            check(first.game().activeRound()!=null
                && first.game().activeRound().drawerParticipantId().equals(hostId)
                && first.canDraw(),"host draws rotating round 1");
            check(!first.game().toString().contains("apple")
                && !first.game().toString().contains("drawerToken"),
                "member public game state does not expose private answer");
            // The shared-room drawer can draw only with a live member session;
            // a native canvas token must not bypass a kick via legacy WS.
            var nativeCanvasToken=canvas.reissueDrawerToken(
                first.game().activeRound().roundId());
            check(!canvas.isAuthorizedDrawer(nativeCanvasToken.drawingCode(),
                    nativeCanvasToken.drawerToken()),
                "shared-room native drawer token cannot authorize legacy WS write");
            forbidden(()->adapter.draw(player.token(),
                "{\"type\":\"canvas.clear\",\"payload\":{}}"),
                "other player cannot write active canvas");
            forbidden(()->adapter.draw(viewer.token(),
                "{\"type\":\"canvas.clear\",\"payload\":{}}"),
                "spectator cannot draw");
            var stroke=adapter.draw(host,"{\"type\":\"canvas.clear\",\"payload\":{}}");
            check(stroke.json().contains("\"sequence\":1")
                && published.size()==1,"authorized canvas persisted and published");
            check("DRAWER_IGNORED".equals(adapter.guess(host,"apple").status()),
                "current drawer cannot answer own round");
            check("WRONG".equals(adapter.guess(player.token(),"wrong").status()),
                "incorrect guess does not score");
            chat.chat(viewer.token(),"roomchat001","apple");
            check(repo.findRoundPublic(first.game().activeRound().roundId())
                .correctGuesses().isEmpty(),
                "ordinary room chat never counts as game guesses");
            check("CORRECT".equals(adapter.guess(viewer.token(),"apple").status()),
                "invited spectator can guess through separate authenticated input");
            check("DUPLICATE_CORRECT".equals(adapter.guess(viewer.token(),"apple").status()),
                "repeated correct guess never awards points twice");
            forbidden(()->adapter.completeRound(player.token()),
                "non-drawer non-host cannot force round completion");
            var afterFirst=adapter.completeRound(host);
            check(afterFirst.game().activeRound()==null,
                "round completion clears active canvas/answer");
            forbidden(()->adapter.startRound(host,"word02","pear",List.of()),
                "round 2 rotates to second member");
            var second=adapter.startRound(player.token(),"word02","pear",List.of());
            check(second.canDraw()
                && second.game().activeRound().drawerParticipantId()
                    .equals(player.memberId()),"round 2 drawer assigned to second player");
            check(adapter.guess(host,"pear").status().equals("CORRECT"),
                "host can guess while second player draws");
            check(adapter.draw(player.token(),
                "{\"type\":\"canvas.clear\",\"payload\":{}}").json()
                    .contains("canvas.clear"),"second drawer writes own canvas");
            adapter.completeRound(player.token());
            var finished=adapter.finish(host);
            check("POST_GAME".equals(finished.room().state().name()),
                "shared room reaches POST_GAME after all rounds");
            conflict(()->adapter.startRound(player.token(),"word03","wrong",List.of()),
                "completed game cannot create extra rounds");

            var db2=new BoardGameDatabase(file);
            db2.initialize();
            var recovered=new GameRoomDrawingService(db2,
                new GameRoomAccessService(db2),
                new DrawingGuessRepository(db2),
                new DrawingGuessGameService(new DrawingGuessRepository(db2),
                    new DrawingSyncService(db2)),
                new DrawingSyncService(db2),(code,event)->{});
            check(recovered.state(host).nativeRoomId().equals(nativeId)
                && recovered.state(host).room().state().name().equals("POST_GAME"),
                "native match binding and common room survive SQLite restart");

            var solo=access.createHostedRoom("drawing_guess","Streamer example",
                "Streamer",SeatRole.PLAYER,1,4);
            String streamer=solo.hostCredential().token();
            access.ready(streamer,true);
            var streamerState=adapter.start(streamer,DrawerPolicy.STREAMER_DRAWER,1,60);
            check(streamerState.game().activeMatch()!=null
                && streamerState.game().activeMatch().totalRounds()==1,
                "single-player streamer game is valid and independent");
            var sViewer=access.join(access.invite(streamer,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(10)).token(),"Audience");
            var streamerRound=adapter.startRound(streamer,"broadcast1",
                "horse",List.of("horses"));
            check(streamerRound.canDraw(),"only streamer begins own secret round");
            check(adapter.guess(sViewer.token(),"horse").status().equals("CORRECT"),
                "spectator member can guess without becoming PLAYER");
            adapter.completeRound(streamer);
            check(adapter.finish(streamer).room().state().name().equals("POST_GAME"),
                "streamer game finishes preserving core Drawing score engine");
            System.out.println("GAME_ROOM_DRAWING_R5_PASSED checks="+checks+
                " modes=rotating,streamer rounds=2+1 player_acl=true"+
                " spectator=guess-only chat=separate canvas=authorized"+
                " legacy=untouched restart=sqlite");
        } finally {
            try(var walk=Files.walk(dir)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try{Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }

    @FunctionalInterface private interface Action {void run()throws Exception;}
    private static void forbidden(Action action,String description)throws Exception{
        checks++;
        try{action.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError("expected forbidden: "+description);
    }
    private static void conflict(Action action,String description)throws Exception{
        checks++;
        try{action.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError("expected conflict: "+description);
    }
    private static void check(boolean okay,String description){
        checks++;
        if(!okay)throw new AssertionError(description);
    }
}
