package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomModels.SeatRole;
import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;

/** R13f: the server clock, not a browser timer, advances the public album. */
public final class GameRoomTelephoneAutoplayR13fProbe {
    private static int checks;
    private GameRoomTelephoneAutoplayR13fProbe(){}

    public static void main(String[] args)throws Exception {
        var directory=Files.createTempDirectory("telephone-autoplay-r13f-");
        try{
            var file=directory.resolve("game.db");
            var db=new BoardGameDatabase(file);db.initialize();
            var access=new GameRoomAccessService(db);
            var game=new GameRoomTelephoneService(db,access);
            var hosted=access.createHostedRoom("drawing_guess","Autoplay",
                "Host",SeatRole.PLAYER,3,5);
            String host=hosted.hostCredential().token();
            String room=hosted.room().roomId();
            var b=access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofMinutes(20)).token(),"Second");
            var c=access.join(access.invite(host,SeatRole.PLAYER,1,
                Duration.ofMinutes(20)).token(),"Third");
            var spectator=access.join(access.invite(host,SeatRole.SPECTATOR,1,
                Duration.ofMinutes(20)).token(),"Observer");
            access.ready(host,true);access.ready(b.token(),true);
            access.ready(c.token(),true);
            game.start(host,90);
            forbidden(()->game.playback(spectator.token(),"PLAY",3,0),
                "observer never controls autoplay");
            forbidden(()->game.playback(b.token(),"PLAY",3,0),
                "ordinary player never controls autoplay");
            conflict(()->game.playback(host,"PLAY",3,0),
                "cannot start slideshow before albums are revealed");
            String[] players={host,b.token(),c.token()};
            for(int stage=0;stage<3;stage++) {
                for(int member=0;member<3;member++) {
                    game.submit(players[member],stage,
                        stage%2==0?"word "+member:null,
                        stage%2==1?"[[{\"x\":0.4,\"y\":0.6}]]":null);
                }
            }
            var initial=game.state(host);
            check(!initial.playback().playing()
                && initial.playback().intervalSeconds()==5
                && initial.playback().nextAt()==null,
                "legacy gallery starts paused at five second speed");
            invalid(()->game.playback(host,"PLAY",2,0),
                "speed cannot be faster than three seconds");
            invalid(()->game.playback(host,"SPEED",21,0),
                "speed cannot exceed twenty seconds");
            invalid(()->game.playback(host,"SKIP",5,0),
                "unrecognized playback commands fail closed");
            var started=game.playback(host,"PLAY",3,0);
            check(started.playback().playing() && started.playback().intervalSeconds()==3
                && started.presentation().revision()==1,
                "host starts versioned server-clock playback");
            check(game.playback(host,"PLAY",3,0).presentation().revision()==1,
                "identical play retry neither restarts deadline nor revision");
            conflict(()->game.present(host,1,1,1),
                "manual navigation requires pausing automatic slideshow");
            expire(db,room,1);
            var tick=game.state(spectator.token());
            check(tick.presentation().albumIndex()==0
                && tick.presentation().stepIndex()==1
                && tick.presentation().revision()==2
                && tick.playback().playing(),
                "guest GET materializes server-owned elapsed slide");
            check(game.state(b.token()).presentation().revision()==2,
                "simultaneous players cannot advance a tick twice");
            conflict(()->game.playback(host,"PAUSE",3,1),
                "host commands reject stale playback revisions");
            var pause=game.playback(host,"PAUSE",3,2);
            check(!pause.playback().playing()
                && pause.playback().nextAt()==null
                && pause.presentation().stepIndex()==1
                && pause.presentation().revision()==3,
                "pause freezes exact committed frame");
            check(game.state(spectator.token()).presentation().revision()==3,
                "paused frame remains stationary on subsequent GET");
            var speed=game.playback(host,"SPEED",8,3);
            check(speed.playback().intervalSeconds()==8
                && !speed.playback().playing()
                && speed.presentation().revision()==4,
                "host configures speed independently of playback");
            check(game.playback(host,"PAUSE",8,3).presentation().revision()==4,
                "repeated pause remains idempotent");
            var restartedDb=new BoardGameDatabase(file);restartedDb.initialize();
            var restarted=new GameRoomTelephoneService(restartedDb,
                new GameRoomAccessService(restartedDb));
            check(restarted.state(spectator.token()).playback().intervalSeconds()==8
                && restarted.state(spectator.token()).presentation().stepIndex()==1,
                "paused position and chosen speed survive SQLite restart");
            var resumed=restarted.playback(host,"PLAY",8,4);
            check(resumed.playback().playing()
                && resumed.presentation().revision()==5,
                "host resumes from previously frozen slide");
            expire(restartedDb,room,17);
            var catchup=restarted.state(c.token());
            check(catchup.presentation().albumIndex()==1
                && catchup.presentation().stepIndex()==1
                && catchup.presentation().revision()==8,
                "server catches up three elapsed frames in one transaction");
            var frozen=restarted.playback(host,"PAUSE",8,8);
            check(frozen.presentation().revision()==9
                && frozen.presentation().stepIndex()==1,
                "host pauses correctly after multi-slide catch-up");
            var manual=restarted.present(host,2,1,9);
            check(manual.presentation().revision()==10
                && manual.presentation().albumIndex()==2,
                "manual gallery controls work again after pause");
            restarted.playback(host,"PLAY",3,10);
            expire(restartedDb,room,100);
            var completed=restarted.state(spectator.token());
            check(completed.presentation().albumIndex()==2
                && completed.presentation().stepIndex()==2
                && completed.presentation().revision()==12
                && !completed.playback().playing()
                && completed.playback().nextAt()==null,
                "automatic playback stops at final slide, never wraps silently");
            var again=restarted.playback(host,"PLAY",3,12);
            check(again.presentation().albumIndex()==0
                && again.presentation().stepIndex()==0
                && again.playback().playing(),
                "play from last slide explicitly restarts presentation");
            var otherRoom=access.createHostedRoom("drawing_guess",
                "Unrelated room","Other",SeatRole.PLAYER,3,3);
            check(!restarted.state(otherRoom.hostCredential().token()).active(),
                "autoplay does not leak into other rooms");
            access.closeRoom(host); 
            forbidden(()->restarted.playback(host,"PAUSE",3,13),
                "revoked host session loses playback control immediately");
            System.out.println("GAME_ROOM_R13F_AUTOPLAY_PASSED checks="+checks+
                " clock=server durable=true pause=atomic speed=bounded"+
                " catchup=elapsed logout=secure finish=stops");
        }finally{
            try(var walk=Files.walk(directory)){
                walk.sorted((a,b)->b.compareTo(a)).forEach(p->{
                    try{Files.deleteIfExists(p);}catch(Exception ignored){}
                });
            }
        }
    }
    private static void expire(BoardGameDatabase db,String room,int seconds)
        throws Exception {
        try(var connection=db.open();
            var stmt=connection.prepareStatement("""
                UPDATE game_room_telephone_match SET reveal_next_at=?
                WHERE room_id=? AND reveal_playing=1
                """)){
            stmt.setString(1,Instant.now().minusSeconds(seconds).toString());
            stmt.setString(2,room);
            if(stmt.executeUpdate()!=1)throw new AssertionError(
                "clock fixture must find active auto player");
        }
    }
    @FunctionalInterface private interface Action{void run()throws Exception;}
    private static void check(boolean value,String title){
        checks++;if(!value)throw new AssertionError(title);
    }
    private static void forbidden(Action action,String title)throws Exception{
        checks++;try{action.run();}catch(GameRoomAccessService.Forbidden expected){return;}
        throw new AssertionError(title);
    }
    private static void conflict(Action action,String title)throws Exception{
        checks++;try{action.run();}catch(GameRoomService.RoomConflict expected){return;}
        throw new AssertionError(title);
    }
    private static void invalid(Action action,String title)throws Exception{
        checks++;try{action.run();}catch(IllegalArgumentException expected){return;}
        throw new AssertionError(title);
    }
}
