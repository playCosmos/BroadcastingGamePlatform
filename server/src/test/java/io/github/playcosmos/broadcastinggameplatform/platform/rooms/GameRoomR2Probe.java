package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Real SQLite auth/grant/moderation boundary and multi-session contention. */
public final class GameRoomR2Probe {
    private GameRoomR2Probe() {}
    private static int checks;

    public static void main(String[] args) throws Exception {
        Path dir = Files.createTempDirectory("game-room-r2-");
        try {
            Path dbPath = dir.resolve("platform.db");
            var db = new BoardGameDatabase(dbPath);
            db.initialize();
            var t = Instant.parse("2026-10-21T08:00:00Z");
            var clock = Clock.fixed(t, ZoneOffset.UTC);
            var access = new GameRoomAccessService(db, clock);
            var hosted = access.createHostedRoom("yacht", "Secure Yacht", "Host",
                SeatRole.PLAYER, 2, 4);
            String ownerToken = hosted.hostCredential().token();
            String roomId = hosted.room().roomId();
            check(hosted.room().playerCount() == 1 && hosted.room().memberCount() == 1,
                "host playing occupies one total slot");
            check(ownerToken.length() == 43
                && access.authenticate(ownerToken).isHost(), "host token issued and scoped");
            invalid(() -> access.authenticate("bad"), "weak token is not accepted");
            invalid(() -> access.authenticate("A".repeat(43)),
                "unknown random token cannot grant room power");

            var playerInvite = access.invite(ownerToken, SeatRole.PLAYER, 3,
                Duration.ofHours(1));
            check(playerInvite.token().length() == 43
                && !playerInvite.token().equals(ownerToken),
                "independent 256-bit invite token");
            var guestPlayer = access.join(playerInvite.token(), "Player");
            String playerToken = guestPlayer.token();
            check(access.room(playerToken).playerCount() == 2
                && access.room(playerToken).memberCount() == 2,
                "invited player consumes one of each capacity");
            forbidden(() -> access.invite(playerToken, SeatRole.SPECTATOR, 1,
                Duration.ofHours(1)), "regular player cannot invite");
            conflict(() -> access.join(playerInvite.token(), "ExtraPlayer"),
                "player cap rejects a second invite even if invite remains usable");
            var spectatorInvite = access.invite(ownerToken, SeatRole.SPECTATOR, 3,
                Duration.ofHours(1));
            var guestViewer = access.join(spectatorInvite.token(), "Viewer A");
            var guestViewer2 = access.join(spectatorInvite.token(), "Viewer B");
            check(access.room(ownerToken).memberCount() == 4
                && access.room(ownerToken).playerCount() == 2,
                "spectators fill total room but do not consume player seats");
            conflict(() -> access.join(spectatorInvite.token(), "Viewer C"),
                "total capacity denies final overfill");
            conflict(() -> access.capacity(ownerToken,2,3),
                "host cannot reduce max total below occupancy");
            forbidden(() -> access.capacity(guestViewer.token(),2,5),
                "guest cannot change capacity");
            check(access.ready(playerToken,true).memberForActor(
                access.authenticate(playerToken).actorId()).ready(),
                "player may mark their own seat ready");
            forbidden(() -> access.ready(guestViewer.token(),true),
                "spectator cannot mark ready");

            var disconnected = access.disconnect(guestViewer.token(),
                Duration.ofMinutes(1));
            check(disconnected.memberCount()==4,
                "disconnected member continues to occupy room");
            forbidden(() -> access.invite(guestViewer.token(),SeatRole.SPECTATOR,1,
                Duration.ofMinutes(1)), "spectator cannot create invites");
            var dbNew = new BoardGameDatabase(dbPath);
            dbNew.initialize();
            var restored = new GameRoomAccessService(dbNew,clock);
            check(restored.authenticate(guestViewer.token()).memberId()
                .equals(guestViewer.memberId()), "session persists through process restart");
            check(restored.room(guestViewer.token()).equals(disconnected),
                "complete membership/role snapshot survives restart");
            var recovered = restored.reconnect(guestViewer.token());
            check(recovered.memberCount()==4 && recovered.memberForActor(
                access.authenticate(guestViewer.token()).actorId()).occupies(),
                "reconnect reclaims existing seat");

            // Host transfer must be effective for every token without
            // reissuing privileges. Previously issued host secret loses power.
            var transferred = restored.transferHost(ownerToken,guestViewer.memberId());
            check(transferred.ownerMemberId().equals(guestViewer.memberId()),
                "owner changes without changing membership");
            forbidden(() -> restored.invite(ownerToken,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(1)), "old host immediately loses moderation power");
            var newHostInvite = restored.invite(guestViewer.token(),SeatRole.SPECTATOR,
                1,Duration.ofMinutes(15));
            check(newHostInvite.uses()==1, "new host can issue scoped invite");
            forbidden(() -> restored.kick(ownerToken,guestViewer2.memberId()),
                "former host cannot kick members");
            var kicked = restored.kick(guestViewer.token(),guestViewer2.memberId());
            check(kicked.memberCount()==3
                && kicked.playerCount()==2
                && kicked.members().stream().anyMatch(m ->
                    m.memberId().equals(guestViewer2.memberId())
                    && m.status()==GameRoomModels.MemberStatus.KICKED),
                "kick frees only target spectator member");
            forbidden(() -> restored.authenticate(guestViewer2.token()),
                "kicked member session revoked permanently");
            forbidden(() -> restored.reconnect(guestViewer2.token()),
                "kicked credential cannot resurrect");
            var newcomer=restored.join(newHostInvite.token(),"New");
            check(restored.room(newcomer.token()).memberCount()==4,
                "new member may fill freed slot");
            forbidden(() -> restored.join(newHostInvite.token(),"Replay"),
                "one-use invite cannot be reused");
            var revokedInvite=restored.invite(guestViewer.token(),SeatRole.SPECTATOR,
                2,Duration.ofHours(1));
            restored.revokeInvite(guestViewer.token(),revokedInvite.token());
            forbidden(() -> restored.join(revokedInvite.token(),"Revoked"),
                "revoked invite cannot create member");

            var formerGuestToken=guestPlayer.token();
            var rotated=restored.rotate(formerGuestToken);
            forbidden(() -> restored.authenticate(formerGuestToken),
                "session rotation revokes old token");
            check(restored.authenticate(rotated.token()).memberId()
                .equals(guestPlayer.memberId()), "rotation preserves membership identity");
            var departed=restored.leave(rotated.token());
            check(departed.playerCount()==1 && departed.memberCount()==3,
                "nonhost leave releases player/room seat");
            forbidden(() -> restored.authenticate(rotated.token()),
                "leaving revokes all member sessions");
            conflict(() -> restored.leave(guestViewer.token()),
                "current host cannot abandon room");
            var logout=restored.rotate(ownerToken);
            restored.revoke(logout.token());
            forbidden(() -> restored.authenticate(logout.token()),
                "explicit token revocation denies future access");
            check(restored.authenticate(guestViewer.token()).isHost(),
                "logging out a former host does not affect successor");

            var expired=restored.invite(guestViewer.token(),SeatRole.SPECTATOR,1,
                Duration.ofSeconds(5));
            var future=new GameRoomAccessService(
                new BoardGameDatabase(dbPath),
                Clock.fixed(t.plusSeconds(6),ZoneOffset.UTC));
            forbidden(() -> future.join(expired.token(),"Late"),
                "expired invite fails closed across server restart");
            invalid(() -> restored.invite(guestViewer.token(),SeatRole.PLAYER,257,
                Duration.ofMinutes(1)), "invite max use bounded");
            invalid(() -> restored.invite(guestViewer.token(),SeatRole.PLAYER,1,
                Duration.ofDays(8)), "invite TTL bounded");
            forbidden(() -> future.authenticate("A".repeat(43)),
                "unguessable token not found");

            // One invite and one final room spot: 16 competing JDBC sessions.
            var contestRoom=restored.createHostedRoom("drawing_guess","Contest",
                "Host",SeatRole.SPECTATOR,2,2);
            var contestInvite=restored.invite(contestRoom.hostCredential().token(),
                SeatRole.PLAYER,1,Duration.ofHours(1));
            var gate=new CountDownLatch(1);
            var success=new AtomicInteger();
            var rejected=new AtomicInteger();
            var errors=new AtomicReference<Throwable>();
            var threads=new ArrayList<Thread>();
            for(int i=0;i<16;i++){
                int worker=i;
                threads.add(Thread.ofVirtual().start(() -> {
                    try{
                        var service=new GameRoomAccessService(
                            new BoardGameDatabase(dbPath),clock);
                        gate.await();
                        service.join(contestInvite.token(),"Visitor"+worker);
                        success.incrementAndGet();
                    }catch(GameRoomAccessService.Forbidden
                           |GameRoomService.RoomConflict expected){
                        rejected.incrementAndGet();
                    }catch(Throwable error){errors.compareAndSet(null,error);}
                }));
            }
            gate.countDown();
            for(var thread:threads)thread.join();
            if(errors.get()!=null)throw new AssertionError("invite concurrency failure",errors.get());
            check(success.get()==1 && rejected.get()==15,
                "exactly one of 16 competing invite consumes last room slot");
            check(restored.room(contestRoom.hostCredential().token()).memberCount()==2,
                "no overfill after racing invite joins");
            try(var connection=db.open();
                var query=connection.prepareStatement(
                    "SELECT used,max_uses FROM game_room_invite WHERE invite_hash=?")){
                // Token hashes are not observable from raw token SQL queries.
                var hash=java.security.MessageDigest.getInstance("SHA-256")
                    .digest(contestInvite.token().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                query.setString(1,java.util.HexFormat.of().formatHex(hash));
                try(var rows=query.executeQuery()){
                    check(rows.next() && rows.getInt(1)==1 && rows.getInt(2)==1,
                        "one invite use persisted despite 16 racing requests");
                }
            }
            System.out.println("GAME_ROOM_R2_PASSED checks="+checks
                +" secrets=hashed host_transfer=live privileges=checked"
                +" invite_atomic=true concurrent_join=16 ban=credential-revoked"
                +" ttl=verified sqlite_restart=true");
        }finally{
            try(var walk=Files.walk(dir)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try{Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }

    @FunctionalInterface private interface Attempt {void run()throws Exception;}
    private static void forbidden(Attempt a,String description)throws Exception{
        checks++;
        try{a.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError("expected unauthorized: "+description);
    }
    private static void invalid(Attempt a,String description)throws Exception{
        checks++;
        try{a.run();}catch(IllegalArgumentException|GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError("expected invalid request: "+description);
    }
    private static void conflict(Attempt a,String description)throws Exception{
        checks++;
        try{a.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError("expected room conflict: "+description);
    }
    private static void check(boolean valid,String description){
        checks++;
        if(!valid)throw new AssertionError(description);
    }
}
