package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChatMessageEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.sql.Connection;
import java.time.Duration;
import java.util.List;
import java.util.Set;

public final class GameRoomBroadcastGrantR12cProbe {
    private static int checks;
    private GameRoomBroadcastGrantR12cProbe(){}

    public static void main(String[] args) throws Exception {
        var root=Files.createTempDirectory("broadcast-grant-r12c-");
        try {
            var db=new BoardGameDatabase(root.resolve("state.db"));
            db.initialize();
            var access=new GameRoomAccessService(db);
            var repository=new DrawingGuessRepository(db);
            var drawingGame=new DrawingGuessGameService(
                repository,new DrawingSyncService(db));
            var configured=Set.of("owned","secondary","expired","unapproved");
            var drawing=new GameRoomDrawingService(
                db,access,repository,drawingGame,new DrawingSyncService(db),
                (code,event)->{}, source->"SOOP".equals(source.provider())
                    && configured.contains(source.channelId()));
            var host=access.createHostedRoom("drawing_guess","Primary room",
                "Host",SeatRole.PLAYER,1,3);
            var foreign=access.createHostedRoom("drawing_guess","Foreign room",
                "Host 2",SeatRole.PLAYER,1,3);
            String token=host.hostCredential().token(),room=host.room().roomId();
            String other=foreign.hostCredential().token(),otherRoom=foreign.room().roomId();
            var watcher=access.join(access.invite(token,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(5)).token(),"Watch");
            forbidden(()->drawing.issueChannelGrant(room,"SOOP","not-configured",600),
                "unprovisioned source cannot receive approval");
            invalid(()->drawing.issueChannelGrant(room,"SOOP","owned",59),
                "minimum expiry");
            invalid(()->drawing.issueChannelGrant(room,"SOOP","owned",3601),
                "maximum expiry");
            forbidden(()->drawing.addChannel(watcher.token(),"SOOP","owned",null),
                "spectator cannot claim even with a grant");
            forbidden(()->drawing.addChannel(token,"SOOP","owned",null),
                "host must present a grant");
            forbidden(()->drawing.addChannel(token,"SOOP","owned","fake"),
                "guessable token is not authorization");
            check(drawing.channels(token).isEmpty(),
                "unapproved channel remains invisible");

            access.ready(token,true);
            var match=drawing.start(token,DrawerPolicy.STREAMER_DRAWER,1,180);
            drawing.startRound(token,"r12c-word","grape",List.of());
            // Simulate a V38 label inserted by a legacy/compromised component.
            try(var connection=db.open();var stmt=connection.prepareStatement("""
                INSERT INTO game_room_drawing_broadcast_binding(
                    room_id,provider,channel_id,added_at,authorized_at)
                VALUES(?,'SOOP','unapproved','2026-01-01T00:00:00Z',NULL)
                """)) {
                stmt.setString(1,room);stmt.executeUpdate();
            }
            check(drawing.channels(token).isEmpty(),
                "legacy unverified label must not appear as approved");
            check("NO_ACTIVE_ROOM".equals(drawingGame.processChatMessage(
                chat("unapproved","viewer-a","grape")).status()),
                "unverified legacy label can never route guesses");
            String unverifiedGrant=drawing.issueChannelGrant(room,"SOOP",
                "unapproved",600).grant();
            check(drawing.addChannel(token,"SOOP","unapproved",unverifiedGrant)
                .size()==1,"valid grant promotes legacy label atomically");
            check("CORRECT".equals(drawingGame.processChatMessage(
                chat("unapproved","viewer-a","grape")).status()),
                "only upgraded authorized binding enables scoring");
            forbidden(()->drawing.addChannel(other,"SOOP","secondary",
                drawing.issueChannelGrant(room,"SOOP","secondary",600).grant()),
                "grant cannot be redeemed by a different room");
            String owned=drawing.issueChannelGrant(room,"SOOP","owned",600).grant();
            check(owned.length()==43,"grant has 256 bits of CSPRNG entropy");
            try(var conn=db.open();var stmt=conn.prepareStatement("""
                SELECT grant_hash FROM game_room_drawing_broadcast_grant
                WHERE room_id=? AND provider='SOOP' AND channel_id='owned'
                """)) {
                stmt.setString(1,room);
                try(var rs=stmt.executeQuery()) {
                    check(rs.next() && rs.getString(1).length()==64
                        && !rs.getString(1).contains(owned),
                        "database retains only the SHA-256 grant hash");
                }
            }
            check(drawing.addChannel(token,"SOOP","owned",owned).size()==2,
                "operator-bound host can claim a configured broadcast");
            check(drawing.addChannel(token,"SOOP","owned",null).size()==2,
                "same authorized binding is idempotent without issuing a new grant");
            drawing.removeChannel(token,"SOOP","owned");
            forbidden(()->drawing.addChannel(token,"SOOP","owned",owned),
                "consumed grant cannot rebind after removal");

            String expire=drawing.issueChannelGrant(room,"SOOP","expired",600).grant();
            try(var conn=db.open();var stmt=conn.prepareStatement("""
                UPDATE game_room_drawing_broadcast_grant
                SET expires_at='2000-01-01T00:00:00Z'
                WHERE room_id=? AND channel_id='expired'
                """)) {
                stmt.setString(1,room);stmt.executeUpdate();
            }
            forbidden(()->drawing.addChannel(token,"SOOP","expired",expire),
                "expired grant cannot bind a channel");
            var reopened=new BoardGameDatabase(root.resolve("state.db"));
            reopened.initialize();
            var recovered=new GameRoomDrawingService(reopened,
                new GameRoomAccessService(reopened),new DrawingGuessRepository(reopened),
                new DrawingGuessGameService(new DrawingGuessRepository(reopened),
                    new DrawingSyncService(reopened)),new DrawingSyncService(reopened),
                (code,event)->{}, source->"SOOP".equals(source.provider())
                    && configured.contains(source.channelId()));
            check(recovered.channels(token).size()==1,
                "only approved bindings survive SQLite reopen");
            forbidden(()->recovered.addChannel(token,"SOOP","owned",owned),
                "single-use consumption persists after restart");
            drawing.completeRound(token);drawing.finish(token);
            access.closeRoom(token);
            forbidden(()->recovered.channels(token),
                "revoked room token cannot read grants");
            String approvedAgain=drawing.issueChannelGrant(otherRoom,"SOOP",
                "unapproved",600).grant();
            check(recovered.addChannel(other,"SOOP","unapproved",approvedAgain)
                .size()==1,"closed-room binding released for another host");
            System.out.println("GAME_ROOM_R12C_CHANNEL_GRANT_PASSED checks="+checks+
                " hash=sha256 ttl=bounded consume=atomic scope=room"+
                " unverified=fail-closed restart=sqlite");
        } finally {
            try(var paths=Files.walk(root)){
                paths.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }

    private static ChatMessageEvent chat(String channel,String user,String guess) {
        return new ChatMessageEvent("SOOP",channel,user,user,guess,null,
            System.currentTimeMillis());
    }
    @FunctionalInterface private interface Action{void run()throws Exception;}
    private static void forbidden(Action action,String msg)throws Exception {
        checks++;
        try {action.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError(msg);
    }
    private static void invalid(Action action,String msg)throws Exception {
        checks++;
        try {action.run();}catch(IllegalArgumentException expected){return;}
        throw new AssertionError(msg);
    }
    private static void check(boolean pass,String msg) {
        checks++;
        if(!pass)throw new AssertionError(msg);
    }
}
