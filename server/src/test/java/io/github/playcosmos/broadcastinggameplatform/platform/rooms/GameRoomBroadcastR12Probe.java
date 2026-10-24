package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChatMessageEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;

/** R12a: multi-channel guest-neutral binding and exactly-once scoring. */
public final class GameRoomBroadcastR12Probe {
    private static int checks;
    private GameRoomBroadcastR12Probe() {}

    public static void main(String[] args) throws Exception {
        var dir=Files.createTempDirectory("game-room-r12-");
        try {
            var file=dir.resolve("room.db");
            var db=new BoardGameDatabase(file);
            db.initialize();
            var access=new GameRoomAccessService(db);
            var repo=new DrawingGuessRepository(db);
            var sync=new DrawingSyncService(db);
            var game=new DrawingGuessGameService(repo,sync);
            var drawing=new GameRoomDrawingService(db,access,repo,game,sync,(id,json)->{});
            var first=access.createHostedRoom("drawing_guess","Stream group",
                "Streamer A",SeatRole.PLAYER,1,4);
            var other=access.createHostedRoom("drawing_guess","Other host",
                "Streamer B",SeatRole.PLAYER,1,4);
            String host=first.hostCredential().token();
            String otherHost=other.hostCredential().token();
            String roomId=first.room().roomId();
            var spectator=access.join(access.invite(host,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(10)).token(),"Viewer");

            check(drawing.channels(host).isEmpty(),"new room has no broadcast bindings");
            forbidden(()->drawing.addChannel(spectator.token(),"SOOP","stream-a"),
                "spectator cannot bind");
            forbidden(()->drawing.removeChannel(spectator.token(),"SOOP","stream-a"),
                "spectator cannot remove");
            invalid(()->drawing.addChannel(host,"GAMECENTER","stream-a"),
                "native member identity cannot be bound externally");
            invalid(()->drawing.addChannel(host,"SOOP","bad channel id!"),
                "invalid channel identifier rejected");
            drawing.addChannel(host,"soop","stream-a");
            drawing.addChannel(host,"SOOP","stream-b");
            check(drawing.addChannel(host,"SOOP","stream-a").size()==2,
                "retry of same binding is idempotent");
            conflict(()->drawing.addChannel(otherHost,"SOOP","stream-a"),
                "one external channel cannot be bound to two shared rooms");
            check(drawing.channels(spectator.token()).size()==2,
                "member sees public provider/channel binding without credentials");
            check(drawing.channels(host).stream().allMatch(x->x.provider().equals("SOOP")),
                "provider identity normalized");
            for(int i=0;i<6;i++)drawing.addChannel(host,"SOOP","extra-"+i);
            check(drawing.channels(host).size()==8,"room channel limit at eight");
            conflict(()->drawing.addChannel(host,"SOOP","extra-6"),
                "ninth channel denied");
            for(int i=0;i<6;i++)drawing.removeChannel(host,"SOOP","extra-"+i);
            check(drawing.channels(host).size()==2,"bounded list remains mutable");

            access.ready(host,true);
            var started=drawing.start(host,DrawerPolicy.STREAMER_DRAWER,1,180);
            check(started.nativeRoomId()!=null,"shared game started");
            var round=drawing.startRound(host,"r12-word","horse",List.of("horses"));
            String roundId=round.game().activeRound().roundId();
            check("NO_ACTIVE_ROOM".equals(game.processChatMessage(
                chat("SOOP","unbound","user-x","horse")).status()),
                "unbound external events do not enter the room");
            check("STALE_EVENT".equals(game.processChatMessage(
                new ChatMessageEvent("SOOP","stream-a","old-user","Old",
                    "horse",null,System.currentTimeMillis()-600_000)).status()),
                "replayed pre-round chat cannot score current prompt");
            check("WRONG".equals(game.processChatMessage(
                chat("SOOP","stream-a","alice","cat")).status()),
                "bound incorrect guess follows existing judge");
            var correct=game.processChatMessage(
                chat("SOOP","stream-a","alice","horse"));
            check("CORRECT".equals(correct.status())
                && started.nativeRoomId().equals(correct.roomId()),
                "first channel feeds native authoritative score engine");
            check("DUPLICATE_CORRECT".equals(game.processChatMessage(
                chat("SOOP","stream-b","alice","horse")).status()),
                "same provider-scoped viewer scores once across channels");
            check("CORRECT".equals(game.processChatMessage(
                chat("SOOP","stream-b","bob","horses")).status()),
                "second channel shares answer and round");
            check(repo.findRoundPublic(roundId).correctGuesses().size()==2,
                "two distinct viewers score once, no per-channel duplicate");
            check("DRAWER_IGNORED".equals(drawing.guess(host,"horse").status()),
                "native GAMECENTER drawer guess remains isolated");

            var reopened=new BoardGameDatabase(file);
            reopened.initialize();
            var adapter2=new GameRoomDrawingService(reopened,
                new GameRoomAccessService(reopened),new DrawingGuessRepository(reopened),
                new DrawingGuessGameService(new DrawingGuessRepository(reopened),
                    new DrawingSyncService(reopened)),new DrawingSyncService(reopened),
                (code,json)->{});
            check(adapter2.channels(host).size()==2,
                "room bindings recover from SQLite restart");
            adapter2.removeChannel(host,"SOOP","stream-a");
            check("NO_ACTIVE_ROOM".equals(game.processChatMessage(
                chat("SOOP","stream-a","charlie","horse")).status()),
                "removed channel no longer enters the active round");
            check("CORRECT".equals(game.processChatMessage(
                chat("SOOP","stream-b","charlie","horse")).status()),
                "remaining channel keeps scoring after removal");
            drawing.completeRound(host);
            drawing.finish(host);
            check("NO_ACTIVE_ROOM".equals(game.processChatMessage(
                chat("SOOP","stream-b","diana","horse")).status()),
                "completed room cannot score further broadcast messages");
            check(adapter2.channels(host).size()==1,
                "room binding still auditable after finish");
            conflict(()->adapter2.addChannel(host,"SOOP","new-after-finish"),
                "closed match cannot silently accept bindings");
            System.out.println("GAME_ROOM_BROADCAST_R12_PASSED checks="+checks+
                " channels=2 host_acl=true duplicate_score=blocked"+
                " persistence=sqlite source=event_bus guest_parity=true");
        } finally {
            try(var walk=Files.walk(dir)) {
                walk.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try {Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }

    private static ChatMessageEvent chat(String provider,String channel,
                                         String user,String message) {
        return new ChatMessageEvent(provider,channel,user,user,
            message,null,System.currentTimeMillis());
    }
    @FunctionalInterface private interface Action {void run()throws Exception;}
    private static void forbidden(Action action,String label)throws Exception {
        checks++;
        try {action.run();} catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError(label);
    }
    private static void conflict(Action action,String label)throws Exception {
        checks++;
        try {action.run();} catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError(label);
    }
    private static void invalid(Action action,String label)throws Exception {
        checks++;
        try {action.run();} catch(IllegalArgumentException expected){return;}
        throw new AssertionError(label);
    }
    private static void check(boolean ok,String label) {
        checks++;
        if(!ok)throw new AssertionError(label);
    }
}
