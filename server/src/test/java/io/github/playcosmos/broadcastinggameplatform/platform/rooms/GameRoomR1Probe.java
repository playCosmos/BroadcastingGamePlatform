package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.MemberStatus;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Real SQLite R1 invariants, reboot recovery and cross-instance writer races. */
public final class GameRoomR1Probe {
    private static int assertions;
    private GameRoomR1Probe() {}

    public static void main(String[] args) throws Exception {
        var dir = Files.createTempDirectory("game-room-r1-");
        try {
            var dbPath = dir.resolve("platform.sqlite3");
            var database = new BoardGameDatabase(dbPath);
            database.initialize();
            var at = Instant.parse("2026-10-21T10:00:00Z");
            var initialClock = Clock.fixed(at, ZoneOffset.UTC);
            var service = new GameRoomService(database, initialClock);

            var room = service.create("yacht", "Game 02", "host",
                "Host", SeatRole.PLAYER, 6, 20);
            String id = room.roomId();
            check(room.memberCount() == 1 && room.playerCount() == 1
                && room.spectatorCount() == 0, "host/player is ONE person");
            check(room.host().memberId().equals(room.ownerMemberId()),
                "exactly one owner with independent room authority");
            check(room.host().seatRole() == SeatRole.PLAYER, "host can play");
            check(room.roomCode().matches("[A-HJ-NP-Z2-9]{6}"), "generated room code");
            check(service.findByCode("yacht", room.roomCode()).equals(room),
                "game-scoped code lookup");
            missing(() -> service.findByCode("drawing_guess",room.roomCode()),
                "same code must not authorize another game");

            for(int i=1;i<=4;i++) service.join(id,"player"+i,"Player"+i,SeatRole.PLAYER);
            for(int i=1;i<=8;i++) service.join(id,"viewer"+i,"Viewer"+i,SeatRole.SPECTATOR);
            room=service.find(id);
            check(room.playerCount()==5 && room.memberCount()==13
                && room.spectatorCount()==8, "host+4 players+8 spectators -> 13 people");
            var firstViewer = room.memberForActor("viewer1");
            var promoted=service.changeSeat(id,"viewer1",SeatRole.PLAYER);
            check(promoted.memberCount()==13 && promoted.playerCount()==6
                && promoted.spectatorCount()==7, "promotion uses existing member, no extra occupancy");
            check(promoted.memberForActor("viewer1").memberId()
                .equals(firstViewer.memberId()), "promotion preserves identity");
            conflict(() -> service.changeSeat(id,"viewer2",SeatRole.PLAYER),
                "player capacity applies to spectator promotion");
            conflict(() -> service.join(id,"extraPlayer","Extra",SeatRole.PLAYER),
                "full player slots reject new PLAYER");
            for(int i=9;i<=15;i++)service.join(id,"viewer"+i,"Viewer"+i,SeatRole.SPECTATOR);
            room=service.find(id);
            check(room.memberCount()==20 && room.playerCount()==6,
                "fifteen spectators plus host and four players fill full room");
            conflict(() -> service.join(id,"viewer16","Extra",SeatRole.SPECTATOR),
                "total capacity rejects additional spectators");
            conflict(() -> service.setCapacity(id,5,20),"cannot shrink player limit below 6");
            conflict(() -> service.setCapacity(id,6,19),"cannot shrink room limit below 20");
            invalid(() -> service.setCapacity(id,22,20),"player limit cannot exceed total");
            var before = room;
            var duplicate = service.join(id,"viewer3","Viewer3",SeatRole.SPECTATOR);
            check(duplicate.equals(before), "duplicate connection uses original seat");
            conflict(() -> service.join(id,"viewer3","Viewer3",SeatRole.PLAYER),
                "duplicate join cannot silently elevate player privileges");
            var limited = service.setCapacity(id,6,20);
            check(limited.version()==before.version(),"unchanged policy is idempotent");
            conflict(() -> service.leave(id,"host"),"owner cannot abandon room before transfer");

            var disconnected = service.disconnect(id,"viewer2",Duration.ofMinutes(1));
            check(disconnected.memberCount()==20
                && disconnected.memberForActor("viewer2").status()
                   == MemberStatus.DISCONNECTED_GRACE,
                "disconnect grace occupies room capacity");
            conflict(() -> service.join(id,"viewer16","Extra",SeatRole.SPECTATOR),
                "temporarily offline viewer still reserves seat");
            var dbRestarted=new BoardGameDatabase(dbPath);
            dbRestarted.initialize();
            var recovered = new GameRoomService(dbRestarted,initialClock);
            check(recovered.find(id).equals(disconnected),
                "all members, owner and reservations recover after SQLite reopen");
            var back = recovered.reconnect(id,"viewer2");
            check(back.memberCount()==20
                && back.memberForActor("viewer2").memberId()
                     .equals(firstViewer.memberId())==false
                && back.memberForActor("viewer2").status()==MemberStatus.JOINED,
                "reconnect reclaims same member without duplicate person");
            var timedOut = recovered.disconnect(id,"viewer2",Duration.ofSeconds(10));
            var later = new GameRoomService(new BoardGameDatabase(dbPath),
                Clock.fixed(at.plusSeconds(11), ZoneOffset.UTC));
            conflict(() -> later.reconnect(id,"viewer2"),
                "expired grace token is not enough to reconnect");
            check(later.find(id).memberCount()==20,
                "expired participant remains reserved until game-safe eviction");
            var vacated = service.leave(id,"viewer4");
            check(vacated.memberCount()==19
                && vacated.memberForActor("viewer4").status()==MemberStatus.LEFT,
                "normal leave frees exactly one member slot");
            var restored = service.join(id,"viewer4","Viewer4",SeatRole.SPECTATOR);
            check(restored.memberCount()==20
                && restored.memberForActor("viewer4").memberId()
                    .equals(vacated.memberForActor("viewer4").memberId()),
                "rejoining after leaving reuses durable member identity");
            check(restored.playerCount()==6,"returning as spectator does not use player seat");
            invalid(() -> service.create("yacht","No","host","Host",SeatRole.PLAYER,6,5),
                "reject capacity where players exceed total members");
            invalid(() -> service.create("yacht","No","host","Host",SeatRole.PLAYER,6,257),
                "reject unbounded technical capacity");
            invalid(() -> service.create("BAD GAME!","No","host","Host",
                SeatRole.PLAYER,6,20),"game ID required to be stable");

            // Two DIFFERENT service instances contend for the last player slot.
            var playerRace=service.create("drawing_guess","Player race",
                "race-host","Host",SeatRole.SPECTATOR,2,30);
            service.join(playerRace.roomId(),"race-player1","One",SeatRole.PLAYER);
            contest(dbPath,playerRace.roomId(),SeatRole.PLAYER,16);
            var afterPlayerRace=service.find(playerRace.roomId());
            check(afterPlayerRace.playerCount()==2
                && afterPlayerRace.memberCount()==3,
                "exactly one final player seat allocated across 16 competitors");

            // Two DIFFERENT services contend for the last total room slot.
            var roomRace=service.create("drawing_guess","Room race",
                "total-host","Host",SeatRole.SPECTATOR,3,3);
            service.join(roomRace.roomId(),"firstViewer","Viewer",SeatRole.SPECTATOR);
            contest(dbPath,roomRace.roomId(),SeatRole.SPECTATOR,16);
            var afterRoomRace=service.find(roomRace.roomId());
            check(afterRoomRace.memberCount()==3 && afterRoomRace.playerCount()==0,
                "exactly one final spectator seat allocated across 16 competitors");

            // Simultaneous joins for the SAME actor must not count multiple people.
            var sameActorRoom=service.create("yacht","Duplicate actor",
                "owner","Owner",SeatRole.SPECTATOR,2,8);
            var gate=new CountDownLatch(1);
            var fail=new AtomicReference<Throwable>();
            var members=new ArrayList<String>();
            var threads=new ArrayList<Thread>();
            for(int i=0;i<8;i++){
                threads.add(Thread.ofVirtual().start(() -> {
                    try {
                        gate.await();
                        var instance=new GameRoomService(new BoardGameDatabase(dbPath));
                        var joined=instance.join(sameActorRoom.roomId(),"sharedActor","One",
                            SeatRole.PLAYER);
                        synchronized(members){members.add(joined.memberForActor("sharedActor").memberId());}
                    } catch(Throwable e){fail.compareAndSet(null,e);}
                }));
            }
            gate.countDown();
            for(var thread:threads)thread.join();
            if(fail.get()!=null)throw new IllegalStateException("duplicate actors failed",fail.get());
            check(members.size()==8 && members.stream().distinct().count()==1,
                "all concurrent sessions have same memberId");
            check(service.find(sameActorRoom.roomId()).memberCount()==2
                && service.find(sameActorRoom.roomId()).playerCount()==1,
                "multiple tabs take only one room and player seat");

            System.out.println("GAME_ROOM_R1_PASSED assertions="+assertions
                +" host_once=true player_and_total_separate=true"
                +" promotion=true sqlite_restart=true grace_reserved=true"
                +" cross_instance_races=32 duplicate_tabs=8");
        } finally {
            try(var walk=Files.walk(dir)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try{Files.deleteIfExists(path);}catch(Exception ignored){}
                });
            }
        }
    }

    private static void contest(Path path,String roomId,SeatRole seat,int writers)
        throws Exception {
        var ready=new CountDownLatch(1);
        var success=new AtomicInteger(), denied=new AtomicInteger();
        var error=new AtomicReference<Throwable>();
        var threads=new ArrayList<Thread>();
        for(int i=0;i<writers;i++){
            final int index=i;
            threads.add(Thread.ofVirtual().start(() -> {
                try{
                    var instance=new GameRoomService(new BoardGameDatabase(path));
                    ready.await();
                    instance.join(roomId,"contender"+index,"Contender",seat);
                    success.incrementAndGet();
                }catch(GameRoomService.RoomConflict expected){
                    denied.incrementAndGet();
                }catch(Throwable failure){error.compareAndSet(null,failure);}
            }));
        }
        ready.countDown();
        for(var thread:threads)thread.join();
        if(error.get()!=null)throw new IllegalStateException("race caused SQL or runtime error",error.get());
        check(success.get()==1 && denied.get()==writers-1,
            "exactly one committed final seat and remaining requests rejected");
    }

    @FunctionalInterface
    private interface Action {void run() throws Exception;}
    private static void conflict(Action action,String description) throws Exception{
        assertions++;
        try{action.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError("expected room conflict: "+description);
    }
    private static void invalid(Action action,String description) throws Exception{
        assertions++;
        try{action.run();}catch(IllegalArgumentException expected){return;}
        throw new AssertionError("expected invalid input: "+description);
    }
    private static void missing(Action action,String description) throws Exception{
        assertions++;
        try{action.run();}catch(java.util.NoSuchElementException expected){return;}
        throw new AssertionError("expected absent room: "+description);
    }
    private static void check(boolean actual,String description){
        assertions++;
        if(!actual)throw new AssertionError(description);
    }
}
