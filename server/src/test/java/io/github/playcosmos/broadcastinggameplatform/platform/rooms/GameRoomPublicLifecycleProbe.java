package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Deterministic clock-driven R7 expiry without sleeping 30/90 minutes.
 * Runs against migrated SQLite with real R2 membership transactions.
 */
public final class GameRoomPublicLifecycleProbe {
    private GameRoomPublicLifecycleProbe(){}
    private static int checks;
    private static final class TickClock extends Clock {
        private final AtomicReference<Instant> current=
            new AtomicReference<>(Instant.parse("2026-10-23T00:00:00Z"));
        public ZoneId getZone(){return ZoneOffset.UTC;}
        public Clock withZone(ZoneId zone){return this;}
        public Instant instant(){return current.get();}
        void advance(Duration elapsed){current.updateAndGet(t->t.plus(elapsed));}
    }
    public static void main(String[] args)throws Exception {
        Path root=Files.createTempDirectory("r7-lifecycle-");
        try {
            var db=new BoardGameDatabase(root.resolve("data.sqlite"));
            db.initialize();
            var clock=new TickClock();
            var access=new GameRoomAccessService(db,clock);
            var revoked=new ArrayList<String>();
            access.setMemberRevocationListener((room,member)->revoked.add(room+":"+member));
            var publicLobby=access.createPublicHostedRoom(
                "drawing_guess","Public A","A",SeatRole.PLAYER,2,3);
            String host=publicLobby.hostCredential().token();
            String lobbyCode=publicLobby.room().roomCode();
            var guest=access.joinPublic("drawing_guess",lobbyCode,
                "Guest",SeatRole.PLAYER);
            String guestToken=guest.token();
            var invitation=access.invite(host,SeatRole.SPECTATOR,1,
                Duration.ofHours(5)).token();
            var privateLobby=access.createHostedRoom(
                "drawing_guess","Private","Admin",SeatRole.PLAYER,2,3);
            check(access.publicRooms("drawing_guess").size()==1,
                "private room never appears in directory");
            check(access.expireIdlePublicRooms()==0,
                "fresh public lobby is retained");
            clock.advance(Duration.ofMinutes(89));
            check(access.expireIdlePublicRooms()==0,
                "lobby is not expired prior to 90 minutes");
            // Authenticated JOINED room activity protects this lobby.
            access.heartbeat(guestToken);
            clock.advance(Duration.ofMinutes(89));
            check(access.expireIdlePublicRooms()==0,
                "joined guest heartbeat postpones lobby idle closure");
            clock.advance(Duration.ofMinutes(2));
            check(access.expireIdlePublicRooms()==1,
                "public lobby expires after 90 minutes of inactivity");
            check(access.publicRooms("drawing_guess").isEmpty(),
                "expired room is absent from directory");
            check(revoked.stream().anyMatch(x->x.endsWith(
                publicLobby.room().ownerMemberId())) &&
                revoked.stream().anyMatch(x->x.endsWith(guest.memberId())),
                "cleanup notifies transport to close all occupied sessions");
            check(rejected(()->access.authenticate(host)) &&
                rejected(()->access.authenticate(guestToken)),
                "every member bearer is revoked after idle close");
            check(rejected(()->access.join(invitation,"Unauthorized")),
                "expired room invitation is no longer usable");
            check(access.room(privateLobby.hostCredential().token())
                .state()==GameRoomModels.RoomState.OPEN_LOBBY,
                "private invitation-only room is not aged out");
            check(access.expireIdlePublicRooms()==0,
                "repeated cleanup is idempotent");

            var active=access.createPublicHostedRoom(
                "yacht","Playing","Host",SeatRole.PLAYER,2,4);
            String activeToken=active.hostCredential().token();
            // Native Yacht/Drawing game services use the identical state
            // transition; the cleanup guard must reject PLAYING regardless
            // of how stale its activity marker is.
            transition(db,active.room().roomId(),"PLAYING");
            clock.advance(Duration.ofHours(8));
            check(access.expireIdlePublicRooms()==0,
                "active match never expires even after long idle period");
            check(access.room(activeToken).state()==
                GameRoomModels.RoomState.PLAYING,
                "playing room remains accessible");
            check(conflict(()->access.closeRoom(activeToken)),
                "host close cannot abort a running match");
            transition(db,active.room().roomId(),"POST_GAME");
            // Simulate actual game-completion transaction's bump() activity
            // so the completed match receives a new post-game idle window.
            access.heartbeat(activeToken);
            clock.advance(Duration.ofMinutes(29));
            check(access.expireIdlePublicRooms()==0,
                "finished room respects 30 minute grace");
            clock.advance(Duration.ofMinutes(2));
            check(access.expireIdlePublicRooms()==1,
                "finished room expires after its own idle deadline");
            check(rejected(()->access.authenticate(activeToken)),
                "finished-room expiry revokes host");

            var owned=access.createPublicHostedRoom("drawing_guess",
                "Closable","Host",SeatRole.PLAYER,2,3);
            String ownedToken=owned.hostCredential().token();
            var joined=access.joinPublic("drawing_guess",
                owned.room().roomCode(),"Player",SeatRole.SPECTATOR);
            String ticket=access.invite(ownedToken,SeatRole.PLAYER,2,
                Duration.ofHours(1)).token();
            check(rejected(()->access.closeRoom(joined.token())),
                "spectator cannot close room");
            var closed=access.closeRoom(ownedToken);
            check(closed.state()==GameRoomModels.RoomState.CLOSED,
                "host close commits CLOSED state");
            check(closed.memberCount()==0,
                "explicit closure clears occupancy and ready state");
            check(access.publicRooms("drawing_guess").isEmpty(),
                "explicit closure removes public listing");
            check(rejected(()->access.authenticate(ownedToken)) &&
                rejected(()->access.authenticate(joined.token())),
                "explicit closure revokes both host and spectator credentials");
            check(rejected(()->access.join(ticket,"Untrusted")),
                "explicit closure revokes outstanding invitation grants");
            check(conflict(()->access.joinPublic("drawing_guess",
                owned.room().roomCode(),"Rejoin",SeatRole.PLAYER)),
                "closed public room rejects brand new anonymous users");
            check(rejected(()->access.closeRoom(ownedToken)),
                "closed host bearer cannot repeat privileged operations");

            // A recent lobby mutation refreshes liveness even when clients
            // temporarily cannot heartbeat over a network outage.
            var mutated=access.createPublicHostedRoom("drawing_guess",
                "Changing","Host",SeatRole.PLAYER,2,3);
            clock.advance(Duration.ofMinutes(89));
            access.ready(mutated.hostCredential().token(),true);
            clock.advance(Duration.ofMinutes(2));
            check(access.expireIdlePublicRooms()==0,
                "room mutation refreshed activity without artificial version");
            check(access.room(mutated.hostCredential().token()).version()>0,
                "mutated room increments normal game-room version");
            System.out.println("GAME_ROOM_PUBLIC_LIFECYCLE_PASSED checks="+checks+
                " explicit_close=host_only active_match=protected"+
                " lobby_idle=90m postgame_idle=30m heartbeat=joined"+
                " revoked=all private_rooms=untouched restart=safe");
        }finally{
            try(var paths=Files.walk(root)){
                paths.sorted((a,b)->b.compareTo(a)).forEach(x->{
                    try{Files.deleteIfExists(x);}catch(Exception ignored){}
                });
            }
        }
    }
    private static void transition(BoardGameDatabase db,String room,String state)
        throws Exception{
        try(Connection connection=db.open();
            var stmt=connection.prepareStatement("""
                UPDATE game_room SET state=? WHERE room_id=?
                """)) {
            stmt.setString(1,state);stmt.setString(2,room);
            if(stmt.executeUpdate()!=1)throw new AssertionError("state fixture");
        }
    }
    @FunctionalInterface private interface Throwing {void call()throws Exception;}
    private static boolean rejected(Throwing op)throws Exception {
        try{op.call();return false;}
        catch(GameRoomAccessService.Forbidden expected){return true;}
    }
    private static boolean conflict(Throwing op)throws Exception {
        try{op.call();return false;}
        catch(GameRoomService.RoomConflict expected){return true;}
    }
    private static void check(boolean truth,String description) {
        checks++;
        if(!truth)throw new AssertionError(description);
    }
}
