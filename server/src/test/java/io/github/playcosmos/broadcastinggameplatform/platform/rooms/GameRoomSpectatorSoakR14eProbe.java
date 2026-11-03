package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

/** R14e bounded high-spectator, concurrent chat and restart soak. */
public final class GameRoomSpectatorSoakR14eProbe {
    private static int checks;
    private GameRoomSpectatorSoakR14eProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("r14e-room-soak-");
        try {
            var file = root.resolve("rooms.sqlite");
            var database = new BoardGameDatabase(file);
            database.initialize();
            var access = new GameRoomAccessService(database);
            var sent = new AtomicInteger();
            var chat = new GameRoomRealtimeService(database,access,
                (room, event) -> sent.incrementAndGet());
            long started = System.nanoTime();
            runRoom("drawing_guess",access,chat,database,sent);
            runRoom("yacht",access,chat,database,sent);
            long elapsed = (System.nanoTime() - started)/1_000_000L;
            // Elapsed time is diagnostic, not a CI performance threshold.
            System.out.println("GAME_ROOM_R14E_SPECTATOR_SOAK_PASSED checks="
                + checks + " spectators=48 concurrentChat=12"
                + " elapsedMs=" + elapsed);
        } finally {
            try(var paths=Files.walk(root)) {
                paths.sorted((a,b)->b.compareTo(a)).forEach(path->{
                    try { Files.deleteIfExists(path); }
                    catch (Exception ignored) {}
                });
            }
        }
    }

    private static void runRoom(String game,GameRoomAccessService access,
        GameRoomRealtimeService chat,BoardGameDatabase database,
        AtomicInteger sent) throws Exception {
        int initialPublished=sent.get();
        var hosted=access.createPublicHostedRoom(game,"R14e "+game,"Owner",
            SeatRole.PLAYER,2,32);
        String host=hosted.hostCredential().token();
        String code=hosted.room().roomCode();
        var viewers=new ArrayList<GameRoomAccessService.Credential>();
        for(int i=0;i<24;i++) {
            viewers.add(access.joinPublic(game,code,
                "Spectator-"+i,SeatRole.SPECTATOR));
        }
        var room=access.room(host);
        require(room.memberCount()==25 && room.playerCount()==1
            && room.maxRoomMembers()==32,
            game+" room capacity counts all members but just one player");
        require(access.publicRooms(game).stream()
            .anyMatch(r->r.roomCode().equals(code)),
            game+" room visible to public guests");
        var trigger=new CountDownLatch(1);
        var failures=new ConcurrentLinkedQueue<Throwable>();
        var workers=new ArrayList<Thread>();
        for(int i=0;i<6;i++) {
            int index=i;
            workers.add(Thread.ofVirtual().start(()->{
                try {
                    trigger.await();
                    String token=viewers.get(index).token();
                    chat.chat(token,"r14e-"+game+"-chat-"+index,
                        "genuine room message "+index);
                } catch(Throwable failure) {
                    failures.add(failure);
                }
            }));
        }
        trigger.countDown();
        for(var worker:workers)worker.join();
        if(!failures.isEmpty())
            throw new AssertionError(game+" concurrent chat failed",failures.peek());
        require(sent.get()-initialPublished==6,
            game+" each of six committed messages published once");
        require(chat.lastSequence(host)==6,
            game+" six writes have unique monotonic event sequence");

        for(int round=0;round<5;round++) {
            for(var member:viewers) {
                access.heartbeat(member.token());
                var history=chat.recentChat(member.token(),-1);
                require(history.messages().size()==6,
                    game+" 24 spectators see 6 committed chats in poll "+round);
            }
        }
        for(int i=0;i<4;i++) {
            String token=viewers.get(i).token();
            access.disconnect(token,Duration.ofSeconds(90));
            access.reconnect(token);
            require(chat.recentChat(token,-1).messages().size()==6,
                game+" disconnected spectator replays chat on reconnect");
        }
        // Different service instances after restart must reconstruct the
        // same durable membership and full public chat from disk.
        var rebooted=new BoardGameDatabase(database.path());
        rebooted.initialize();
        var newAccess=new GameRoomAccessService(rebooted);
        var newChat=new GameRoomRealtimeService(rebooted,newAccess,(a,b)->{});
        require(newAccess.room(host).memberCount()==25,
            game+" spectator count survives DB restart");
        require(newChat.events(host,-1).events().size()==6,
            game+" chat event log survives DB restart");
        require(newChat.recentChat(viewers.get(23).token(),-1)
            .messages().size()==6,
            game+" last spectator can replay messages after restart");

        String kicked=viewers.get(0).token();
        access.kick(host,viewers.get(0).memberId());
        boolean rejected=false;
        try {newChat.recentChat(kicked,-1);}
        catch(GameRoomAccessService.Forbidden expected){rejected=true;}
        require(rejected,game+" kicked spectator cannot read old chat");
        require(newAccess.room(host).memberCount()==24,
            game+" kicked spectator removed from live occupancy");
        access.closeRoom(host);
        rejected=false;
        try {newAccess.authenticate(host);}
        catch(GameRoomAccessService.Forbidden expected){rejected=true;}
        require(rejected,game+" host token revoked when room closes");
        require(newAccess.publicRooms(game).stream()
            .noneMatch(r->r.roomCode().equals(code)),
            game+" closed room removed from public listing");
    }

    private static void require(boolean valid,String what) {
        if(!valid)throw new AssertionError("R14e soak: "+what);
        checks++;
    }
}
