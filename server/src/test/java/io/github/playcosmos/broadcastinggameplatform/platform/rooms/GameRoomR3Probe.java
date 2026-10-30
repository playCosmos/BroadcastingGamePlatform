package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Real SQLite R3 chat, replay, author privacy and room-isolation tests. */
public final class GameRoomR3Probe {
    private static int checks;
    private GameRoomR3Probe() {}

    public static void main(String[] args) throws Exception {
        Path root=Files.createTempDirectory("game-room-r3-");
        try {
            Path file=root.resolve("rooms.db");
            var db=new BoardGameDatabase(file);
            db.initialize();
            var access=new GameRoomAccessService(db);
            var first=access.createHostedRoom("yacht","Private R3","Owner",
                SeatRole.PLAYER,2,5);
            var second=access.createHostedRoom("drawing_guess","Other R3","Other",
                SeatRole.SPECTATOR,3,5);
            String host=first.hostCredential().token();
            String ownerId=first.hostCredential().memberId();
            String outsider=second.hostCredential().token();
            var guest=access.join(access.invite(host,SeatRole.SPECTATOR,3,
                java.time.Duration.ofHours(1)).token(),"Watcher");
            String viewer=guest.token();
            var pushes=new ArrayList<String>();
            var service=new GameRoomRealtimeService(db,access,
                (roomId,json)->pushes.add(roomId+"|"+json));
            var one=service.chat(viewer,"r3message001","  첫 문장 <script>  ");
            check("room.chat.message".equals(one.type()) && one.sequence()==1
                && "첫 문장 <script>".equals(one.text()),
                "room sequence, trim and Unicode safely preserved");
            check(one.memberId().equals(guest.memberId())
                && !one.text().contains(host), "sender identity from token, not body");
            check(pushes.size()==1 && pushes.getFirst().contains(first.room().roomId()),
                "committed chat published to its own room");
            var same=service.chat(viewer,"r3message001","첫 문장 <script>");
            check(same.equals(one) && service.lastSequence(host)==1,
                "same messageId/content does not commit another sequence");
            conflict(() -> service.chat(viewer,"r3message001","replay changed"),
                "messageId reuse with changed contents rejected");
            missing(() -> service.delete(outsider,"r3message001"),
                "other room cannot access foreign message");
            var m2=service.chat(host,"r3message002","Second");
            check(m2.sequence()==2, "room-wide monotonic chat sequence");
            forbidden(() -> service.delete(viewer,"r3message002"),
                "nonhost cannot delete another author's message");
            var deletion=service.delete(host,"r3message001");
            check(deletion.sequence()==3 && deletion.text()==null
                && "room.chat.deleted".equals(deletion.type()),
                "host moderation emits a sequenced tombstone without deleted text");
            var page=service.recentChat(viewer,-1);
            check(page.messages().size()==2 && page.messages().getFirst().deleted()
                && page.messages().getFirst().text()==null
                && !page.messages().getLast().deleted(),
                "deleted bodies masked in paginated history");
            var events=service.events(viewer,-1);
            check(events.events().size()==3 && events.cursor()==3
                && events.events().getLast().text()==null,
                "event replay includes deletion with no content");
            check(service.events(viewer,1).events().size()==2,
                "event cursor is strictly after requested sequence");
            check(service.events(outsider,-1).events().isEmpty()
                && service.lastSequence(outsider)==0,
                "two room event streams isolated");
            check(service.recentChat(outsider,-1).messages().isEmpty(),
                "two room chat histories isolated");
            invalid(() -> service.chat(viewer,"short","message"),
                "message IDs must be sufficiently long");
            invalid(() -> service.chat(viewer,"r3message003","X".repeat(501)),
                "500-character chat bound");
            invalid(() -> service.events(viewer,-2),"invalid replay cursor");

            var restartedDb=new BoardGameDatabase(file);
            restartedDb.initialize();
            var restarted=new GameRoomRealtimeService(restartedDb,
                new GameRoomAccessService(restartedDb),(id,json)->{});
            check(restarted.events(viewer,-1).equals(events),
                "complete event history and cursor survive process restart");
            check(restarted.recentChat(viewer,-1).equals(page),
                "chat redactions survive process restart");

            // Chat publish is at-least-once transport with durable DB source:
            // a dropped socket event is recovered by cursor after restart.
            var offline=new GameRoomRealtimeService(restartedDb,
                new GameRoomAccessService(restartedDb),(id,json)->{
                    throw new RuntimeException("disconnected consumer");
                });
            var offlineMessage=offline.chat(viewer,"r3message004","Offline");
            check(offlineMessage.sequence()==4
                && restarted.events(viewer,3).events().size()==1,
                "failed WebSocket broadcast cannot roll back a committed chat");

            // Two competing JDBC writers reuse the SAME message ID:
            // only one durable message is created, response stays stable.
            String raceId="r3race000005";
            var trigger=new CountDownLatch(1);
            var results=new ArrayList<GameRoomRealtimeService.Event>();
            var errors=new AtomicReference<Throwable>();
            var threads=new ArrayList<Thread>();
            for(int i=0;i<8;i++) {
                threads.add(Thread.ofVirtual().start(()->{
                    try {
                        var otherDb=new BoardGameDatabase(file);
                        var other=new GameRoomRealtimeService(otherDb,
                            new GameRoomAccessService(otherDb),(id,json)->{});
                        trigger.await();
                        var result=other.chat(viewer,raceId,"Same idempotent text");
                        synchronized(results){results.add(result);}
                    }catch(Throwable e){errors.compareAndSet(null,e);}
                }));
            }
            trigger.countDown();
            for(var thread:threads)thread.join();
            if(errors.get()!=null)throw new AssertionError("chat race crashed",errors.get());
            check(results.size()==8
                && results.stream().map(GameRoomRealtimeService.Event::sequence)
                   .distinct().count()==1,
                "eight simultaneous same-ID messages return same durable event");
            check(restarted.lastSequence(host)==5,
                "exactly one new event sequence under concurrent duplicate sends");

            access.disconnect(viewer,java.time.Duration.ofSeconds(60));
            forbidden(() -> restarted.chat(viewer,"r3message006","Disconnected"),
                "grace member cannot send chat");
            access.reconnect(viewer);
            String kickToken=viewer;
            access.kick(host,guest.memberId());
            forbidden(() -> restarted.chat(kickToken,"r3message007","Kicked"),
                "kicked tokens cannot send or read chat");
            forbidden(() -> restarted.events(kickToken,-1),
                "kicked token cannot replay room history");
            check(restarted.events(host,4).events().size()==1,
                "authorized remaining host can continue replay");

            // Freeze only the flood probe's MONOTONIC quota clock. JDBC
            // scheduling under CI can exceed 1 s for five writes, so an
            // unmodified System.nanoTime makes the sixth rejection flaky.
            // The real service still defaults to System::nanoTime.
            var quotaNanos=new java.util.concurrent.atomic.AtomicLong(0);
            var floodService=new GameRoomRealtimeService(db,access,(id,json)->{},
                java.time.Clock.systemUTC(),quotaNanos::get);
            var flood=access.createHostedRoom("yacht","Flood R3","Host",
                SeatRole.SPECTATOR,2,4);
            String floodToken=flood.hostCredential().token();
            GameRoomRealtimeService.Event initial=null;
            for(int i=1;i<=5;i++){
                var result=floodService.chat(floodToken,"flood0000"+i,"Line "+i);
                if(i==1)initial=result;
            }
            var original=initial;
            check(floodService.chat(floodToken,"flood00001","Line 1").equals(original),
                "idempotent retry does not consume quota at limit");
            conflict(() -> floodService.chat(floodToken,"flood00006","Sixth"),
                "sixth distinct message in the SAME monotonic second rejected");
            check(floodService.lastSequence(floodToken)==5,
                "rejected chat and identical retry do not advance event cursor");
            // Advancing the exact rate window proves that new writes are
            // accepted again without sleeping or weakening the 5/s cap.
            quotaNanos.addAndGet(1_000_000_000L);
            check(floodService.chat(floodToken,"flood00006","Sixth").sequence()==6
                && floodService.lastSequence(floodToken)==6,
                "new monotonic second restores chat quota exactly");

            System.out.println("GAME_ROOM_R3_PASSED checks="+checks
                +" events=durable chat=moderated tombstone=redacted"
                +" privacy=isolated pagination=true"
                +" dedup=concurrent8 disconnect=blocked restart=parity");
        } finally {
            try(var walk=Files.walk(root)){
                walk.sorted((x,y)->y.compareTo(x)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }

    @FunctionalInterface private interface Attempt {void run()throws Exception;}
    private static void forbidden(Attempt a,String title)throws Exception {
        checks++;
        try {a.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError("expected denied: "+title);
    }
    private static void missing(Attempt a,String title)throws Exception {
        checks++;
        try {a.run();}catch(java.util.NoSuchElementException expected){return;}
        throw new AssertionError("expected missing: "+title);
    }
    private static void conflict(Attempt a,String title)throws Exception {
        checks++;
        try {a.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError("expected conflict: "+title);
    }
    private static void invalid(Attempt a,String title)throws Exception {
        checks++;
        try {a.run();}catch(IllegalArgumentException expected){return;}
        throw new AssertionError("expected invalid: "+title);
    }
    private static void check(boolean value,String title) {
        checks++;
        if(!value)throw new AssertionError(title);
    }
}
