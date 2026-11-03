package io.github.playcosmos.broadcastinggameplatform.boardserver;

import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.games.yacht.persistence.YachtRoomService;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomAccessService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomDrawingService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomRealtimeService;
import io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomYachtService;
import io.github.playcosmos.broadcastinggameplatform.room.BoardGameRuntimeEngine;
import io.github.playcosmos.broadcastinggameplatform.room.RoomService;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Disposable real HTTP/WS server for Chrome/Edge browser-automation acceptance.
 * The production Yacht and Drawing Guess HTML/CSS/JS are served unmodified.
 * The driver owns process lifetime. Never binds a public interface.
 */
public final class GameRoomBrowserE2EServer {
    private GameRoomBrowserE2EServer(){}
    public static void main(String[] args)throws Exception {
        Path root=Files.createTempDirectory("game-room-browser-e2e-");
        for(String prefix:List.of("games/yacht","games/drawing-guess/room")) {
            var source=Path.of("..","web",prefix);
            var destination=root.resolve("web").resolve(prefix);
            Files.createDirectories(destination);
            try(var files=Files.list(source)) {
                for(Path file:files.filter(Files::isRegularFile).toList()) {
                    if(file.getFileName().toString().endsWith(".html")
                        || file.getFileName().toString().endsWith(".js")
                        || file.getFileName().toString().endsWith(".css")) {
                        Files.copy(file,destination.resolve(file.getFileName()));
                    }
                }
            }
        }
        Files.writeString(root.resolve("web/index.html"),
            "<!doctype html><title>GameRoom browser fixture</title>");
        int adminPort=freePort(),httpPort=freePort(),wsPort=freePort();
        var config=new BoardServerConfig("",
            new BoardServerConfig.Server("127.0.0.1",adminPort,wsPort,
                false,"127.0.0.1",httpPort,"",""),
            new BoardServerConfig.Storage("./data/game.db","./web","./logs"),
            new BoardServerConfig.Soop(false,30)).normalized();
        var database=new BoardGameDatabase(root.resolve("data/game.db"));
        database.initialize();
        var access=new GameRoomAccessService(database);
        var canvas=new DrawingSyncService(database);
        var repository=new DrawingGuessRepository(database);
        var drawingGame=new DrawingGuessGameService(repository,canvas);
        var active=new AtomicReference<BoardGameWebSocketServer>();
        // Mirror PlatformServerMain's committed Yacht event fanout: the
        // previous browser fixture silently discarded every native event.
        // Keep legacy code-channel compatibility AND the authenticated
        // common-room member channel to test the production browser path.
        var yacht=new YachtRoomService(database,()->1,(code,json)->{
            var ws=active.get();
            if(ws==null)return;
            ws.broadcastYacht(code,json);
            try(var connection=database.open();
                var binding=connection.prepareStatement("""
                    SELECT room_id FROM game_room_yacht_link
                    WHERE yacht_room_code=?
                    """)){
                binding.setString(1,code);
                try(var rows=binding.executeQuery()){
                    if(rows.next())ws.broadcastRoomEvent(rows.getString(1),json);
                }
            }catch(java.sql.SQLException failure){
                System.err.println("[yacht] browser fixture member fanout lookup failed");
            }
        });
        var sharedYacht=new GameRoomYachtService(database,access,yacht);
        var realtime=new GameRoomRealtimeService(database,access,(id,event)->{
            var ws=active.get();
            if(ws!=null)ws.broadcastRoomEvent(id,event);
        });
        var drawing=new GameRoomDrawingService(database,access,repository,
            drawingGame,canvas,(code,event)->{
                var ws=active.get();
                if(ws!=null)ws.broadcastDrawingEvent(code,event);
            });
        var websocket=new BoardGameWebSocketServer("127.0.0.1",wsPort,
            code->false,canvas,yacht::exists,access,realtime);
        active.set(websocket);
        websocket.start();
        var http=new GameClientHttpServer(config,root,
            new RoomService(database),new BoardGameRuntimeEngine(database,e->{}),
            new AdminAuthStore(database),new PlatformEventBus(),
            new ProviderRegistry(),null,canvas,drawingGame,yacht,access,
            realtime,sharedYacht,drawing);
        http.start();
        Runtime.getRuntime().addShutdownHook(new Thread(()->{
            http.close();
            try{websocket.stop(1000);}catch(InterruptedException ignored){
                Thread.currentThread().interrupt();
            }
        }));
        System.out.println("GAME_ROOM_BROWSER_FIXTURE_READY http=http://127.0.0.1:"
            +httpPort+" ws=ws://127.0.0.1:"+wsPort+"/");
        System.out.flush();
        Thread.currentThread().join();
    }
    private static int freePort()throws Exception {
        try(var socket=new ServerSocket(0)){return socket.getLocalPort();}
    }
}
