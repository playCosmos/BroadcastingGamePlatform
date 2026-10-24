package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChatMessageEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.util.List;

/** R12d: operator grant listing, bounded pending queue, atomic revocation. */
public final class GameRoomBroadcastGrantR12dProbe {
    private static int checks;
    private GameRoomBroadcastGrantR12dProbe() {}

    public static void main(String[] args) throws Exception {
        var root=Files.createTempDirectory("grant-management-r12d-");
        try {
            var db=new BoardGameDatabase(root.resolve("state.db"));
            db.initialize();
            var access=new GameRoomAccessService(db);
            var repo=new DrawingGuessRepository(db);
            var game=new DrawingGuessGameService(repo,new DrawingSyncService(db));
            var drawing=new GameRoomDrawingService(
                db,access,repo,game,new DrawingSyncService(db),(code,event)->{},
                source->"SOOP".equals(source.provider()));
            var host=access.createHostedRoom("drawing_guess","R12d host",
                "Anonymous host",SeatRole.PLAYER,1,3);
            String token=host.hostCredential().token(),room=host.room().roomId();
            check(drawing.operatorChannels(room).isEmpty(),"no initial privileges");
            String pending=drawing.issueChannelGrant(room,"SOOP","pending",600).grant();
            check(drawing.operatorChannels(room).stream().anyMatch(x->
                x.status().equals("PENDING") && x.channelId().equals("pending")),
                "operator can list pending grant without secret");
            check(!drawing.operatorChannels(room).toString().contains(pending),
                "grant secrets omitted from every operator listing");
            conflict(()->drawing.issueChannelGrant(room,"SOOP","pending",600),
                "duplicate active pending grant requires explicit revocation");
            check(drawing.revokeOperatorChannel(room,"SOOP","pending").isEmpty(),
                "operator revokes pending authorization");
            forbidden(()->drawing.addChannel(token,"SOOP","pending",pending),
                "revoked one-use grant cannot be redeemed");
            String fresh=drawing.issueChannelGrant(room,"SOOP","pending",600).grant();
            check(!fresh.equals(pending),"revoked source may receive fresh grant");
            check(drawing.addChannel(token,"SOOP","pending",fresh).size()==1,
                "host activates channel with new operator authority");
            check(drawing.operatorChannels(room).stream().anyMatch(x->
                x.status().equals("BOUND") && x.channelId().equals("pending")),
                "operator sees bound active channel");
            conflict(()->drawing.issueChannelGrant(room,"SOOP","pending",600),
                "cannot issue duplicate grant to already active channel");

            access.ready(token,true);
            drawing.start(token,DrawerPolicy.STREAMER_DRAWER,1,180);
            drawing.startRound(token,"r12d-word","pear",List.of());
            check("CORRECT".equals(game.processChatMessage(
                chat("pending","guess-one","pear")).status()),
                "authorized SOOP channel scores in active game");

            for(int i=0;i<8;i++)
                drawing.issueChannelGrant(room,"SOOP","queue-"+i,600);
            check(drawing.operatorChannels(room).size()==9,
                "eight pending grants plus one live bound channel");
            conflict(()->drawing.issueChannelGrant(room,"SOOP","queue-nine",600),
                "pending queue bounded at eight");
            check(drawing.revokeOperatorChannel(room,"SOOP","queue-0").size()==8,
                "revocation immediately frees pending quota");
            drawing.issueChannelGrant(room,"SOOP","queue-nine",600);
            check(drawing.operatorChannels(room).size()==9,
                "new grant fits freed quota");

            var reopenedDb=new BoardGameDatabase(root.resolve("state.db"));
            reopenedDb.initialize();
            var persisted=new GameRoomDrawingService(
                reopenedDb,new GameRoomAccessService(reopenedDb),
                new DrawingGuessRepository(reopenedDb),
                new DrawingGuessGameService(new DrawingGuessRepository(reopenedDb),
                    new DrawingSyncService(reopenedDb)),
                new DrawingSyncService(reopenedDb),(code,event)->{},
                source->"SOOP".equals(source.provider()));
            check(persisted.operatorChannels(room).size()==9,
                "admin channel state persists after SQLite reopen");
            persisted.revokeOperatorChannel(room,"SOOP","pending");
            check(drawing.channels(token).isEmpty(),
                "operator immediately removes live channel from room");
            check("NO_ACTIVE_ROOM".equals(game.processChatMessage(
                chat("pending","guess-two","pear")).status()),
                "revoked channel cannot score further events");
            check(persisted.operatorChannels(room).stream().noneMatch(x->
                x.status().equals("BOUND")),"no active source after revoke");
            check(persisted.revokeOperatorChannel(room,"SOOP","pending").size()==8,
                "repeated operator revoke is safe/idempotent");
            check(persisted.issueChannelGrant(room,"SOOP","pending",600).grant()
                .length()==43,"fresh approval possible after full revocation");
            System.out.println("GAME_ROOM_R12D_GRANT_MANAGEMENT_PASSED checks="+checks+
                " issuance=bounded status=no-secrets revoke=atomic"+
                " queued=8 restart=sqlite score=fail-closed");
        } finally {
            try(var walk=Files.walk(root)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }

    private static ChatMessageEvent chat(String channel,String who,String answer) {
        return new ChatMessageEvent("SOOP",channel,who,who,answer,
            null,System.currentTimeMillis());
    }
    @FunctionalInterface private interface Action {void run()throws Exception;}
    private static void conflict(Action action,String label)throws Exception {
        checks++;
        try{action.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError(label);
    }
    private static void forbidden(Action action,String label)throws Exception {
        checks++;
        try{action.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError(label);
    }
    private static void check(boolean ok,String label) {
        checks++;
        if(!ok)throw new AssertionError(label);
    }
}
