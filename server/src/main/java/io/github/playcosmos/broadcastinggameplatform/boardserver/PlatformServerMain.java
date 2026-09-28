package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.Gson;
import io.github.playcosmos.broadcastinggameplatform.config.BridgeConfig;
import io.github.playcosmos.broadcastinggameplatform.operations.FileLog;
import io.github.playcosmos.broadcastinggameplatform.operations.WindowsConsoleEncoding;
import io.github.playcosmos.broadcastinggameplatform.room.BoardGameRuntimeEngine;
import io.github.playcosmos.broadcastinggameplatform.room.RoomHttpHandler;
import io.github.playcosmos.broadcastinggameplatform.room.RoomService;
import io.github.playcosmos.broadcastinggameplatform.soop.SoopBridgeAdapter;
import io.github.playcosmos.broadcastinggameplatform.soop.SoopRuntimeState;
import java.awt.Desktop;
import java.net.URI;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class PlatformServerMain {
    private static final Gson GSON = new Gson();
    private static final long EXIT_WATCHDOG_MILLIS = 10_000L;

    private PlatformServerMain() {}

    public static void main(String[] args) throws Exception {
        WindowsConsoleEncoding.configure();

        if (args.length > 0 && "--board-server-probe".equals(args[0])) {
            System.exit(BoardServerProbe.run());
            return;
        }

        Path root = applicationRoot();
        Path configPath = args.length > 0
            ? resolve(root, args[0])
            : root.resolve("config.json");

        var config = BoardServerConfigLoader.loadOrCreate(configPath);
        var fileLog = FileLog.install(root.resolve(config.storage().logDirectory()));
        var database = new BoardGameDatabase(root.resolve(config.storage().databasePath()));
        database.initialize();

        System.out.println("[platform-server] root=" + root);
        System.out.println("[platform-server] config=" + configPath);
        System.out.println("[platform-server] database=" + database.path());

        var serverPolicies = new ServerPolicyService(database);
        var roomService = new RoomService(
            database,
            serverPolicies::activeRoomLimit
        );
        roomService.terminateExpiredRooms();

        var websocket = new BoardGameWebSocketServer(
            config.server().clientHost(),
            config.server().websocketPort(),
            roomCode -> {
                try {
                    var room = roomService.find(roomCode);
                    var lifecycle = room.lifecycle();
                    if (!"READY".equals(room.status()) || lifecycle == null) {
                        return false;
                    }
                    String state = lifecycle.state();
                    return "ACTIVE".equals(state) || "PAUSED".equals(state);
                } catch (Exception error) {
                    return false;
                }
            }
        );
        websocket.start();

        var runtime = new BoardGameRuntimeEngine(
            database,
            event -> websocket.broadcastEvent(
                event.roomId(),
                GSON.toJson(event)
            )
        );
        int recovered = runtime.recoverQueuedDonations();
        if (recovered > 0) {
            System.out.println("[platform-server] recovered queued donations=" + recovered);
        }

        var lifecycleExecutor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "board-room-lifecycle");
            thread.setDaemon(true);
            return thread;
        });
        lifecycleExecutor.scheduleAtFixedRate(() -> {
            try {
                int terminated = roomService.terminateExpiredRooms();
                if (terminated > 0) {
                    System.out.println("[board-room] auto-terminated=" + terminated);
                }
            } catch (Exception error) {
                System.err.println("[board-room] expiry scan failed: " + error.getMessage());
            }
        }, 1, 1, TimeUnit.MINUTES);

        var roomHttp = new RoomHttpHandler(roomService, runtime);
        var soopState = new SoopRuntimeState(config.streamerId());

        var bridgeConfig = new BridgeConfig(
            config.streamerId(),
            BridgeConfig.defaults().ticket(),
            new BridgeConfig.Server(
                config.server().host(),
                config.server().port(),
                config.server().websocketPort(),
                config.server().openBrowserOnStart()
            ),
            new BridgeConfig.Storage(
                config.storage().databasePath(),
                "./unused-tickets",
                config.storage().webRoot(),
                "./unused-backups",
                config.storage().logDirectory()
            ),
            new BridgeConfig.Soop(
                config.soop().enabled(),
                config.soop().offlinePollSeconds()
            )
        ).normalized();

        var soop = new SoopBridgeAdapter(
            bridgeConfig,
            soopState,
            donation -> {
                try {
                    var result = runtime.process(donation);
                    if (
                        result.processedRooms() > 0 ||
                        result.duplicateRooms() > 0 ||
                        result.queuedRooms() > 0 ||
                        result.ignoredRooms() > 0
                    ) {
                        System.out.println(
                            "[board-game] donor=" + donation.donorId()
                                + " balloons=" + donation.balloonCount()
                                + " matched=" + result.matchedRooms()
                                + " processed=" + result.processedRooms()
                                + " queued=" + result.queuedRooms()
                                + " ignored=" + result.ignoredRooms()
                                + " duplicates=" + result.duplicateRooms()
                        );
                    }
                } catch (Exception error) {
                    System.err.println("[board-game] donation processing failed: " + error.getMessage());
                    error.printStackTrace(System.err);
                }
            },
            (bid, event) -> {}
        );

        var adminAuthStore = new AdminAuthStore(database);
        var clientHttp = new GameClientHttpServer(
            config,
            root,
            roomService,
            runtime,
            adminAuthStore
        );
        var http = new BoardGameHttpServer(
            config,
            root,
            database.path(),
            websocket::connectedClients,
            soopState::snapshot,
            roomHttp,
            roomService,
            serverPolicies,
            clientHttp::adminBootstrapUrl,
            clientHttp::localAdminBootstrapUrl,
            clientHttp::activeAdminSessionCount,
            clientHttp::pendingAdminApprovalCount,
            clientHttp::approveAdminAccess,
            clientHttp::revokeAdminSessions,
            clientHttp::rotateAdminAccess,
            soop::reconnectNow
        );
        http.start();
        clientHttp.start();
        soop.start();

        String adminUrl = clientHttp.localAdminBootstrapUrl();
        String serverManagementUrl = "http://127.0.0.1:"
            + config.server().port() + "/";
        System.out.println("[server-management] " + serverManagementUrl);
        System.out.println("[platform-admin] " + adminUrl);
        System.out.println(
            "[platform-client] http://" + config.server().clientHost()
                + ":" + config.server().clientPort()
        );
        System.out.println(
            "[remote-admin] " + clientHttp.adminBootstrapUrl()
        );
        if (!config.server().publicBaseUrl().isBlank()) {
            System.out.println(
                "[platform-public] " + config.server().publicBaseUrl()
            );
        }

        var shutdown = new CountDownLatch(1);
        var shutdownStarted = new AtomicBoolean(false);
        var trayRef = new AtomicReference<PlatformTrayController>();

        Runnable stop = () -> {
            if (!shutdownStarted.compareAndSet(false, true)) return;
            var tray = trayRef.getAndSet(null);
            if (tray != null) {
                try { tray.close(); } catch (Exception ignored) {}
            }
            lifecycleExecutor.shutdownNow();
            try { http.close(); } catch (Exception ignored) {}
            try { clientHttp.close(); } catch (Exception ignored) {}
            try { websocket.stop(2000); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            catch (Exception ignored) {}
            try { soop.close(); } catch (Exception ignored) {}
            try { fileLog.close(); } catch (Exception ignored) {}
            shutdown.countDown();
        };

        Runnable explicitExit = () -> {
            Thread.ofPlatform().daemon(true).name("board-server-exit-watchdog").start(() -> {
                try {
                    Thread.sleep(EXIT_WATCHDOG_MILLIS);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                    return;
                }
                if (shutdown.getCount() > 0) Runtime.getRuntime().halt(0);
            });
            stop.run();
            System.exit(0);
        };

        Runtime.getRuntime().addShutdownHook(
            Thread.ofPlatform().name("board-server-shutdown").unstarted(stop)
        );

        var tray = PlatformTrayController.install(
            serverManagementUrl,
            adminUrl,
            soopState::status,
            soop::reconnectNow,
            explicitExit
        );
        trayRef.set(tray);

        if (
            config.streamerId() == null ||
            config.streamerId().isBlank() ||
            tray == null ||
            config.server().openBrowserOnStart()
        ) {
            openBrowser(adminUrl);
        }

        shutdown.await();
    }

    private static Path applicationRoot() {
        String override = System.getenv("BROADCASTING_GAME_PLATFORM_HOME");
        if (override == null || override.isBlank()) {
            override = System.getenv("RAMYANI_BOARD_GAME_SERVER_HOME");
        }
        if (override != null && !override.isBlank()) {
            return Path.of(override).toAbsolutePath().normalize();
        }
        String launcher = System.getProperty("jpackage.app-path");
        if (launcher != null && !launcher.isBlank()) {
            Path parent = Path.of(launcher).toAbsolutePath().normalize().getParent();
            if (parent != null) return parent;
        }
        return Path.of("").toAbsolutePath().normalize();
    }

    private static Path resolve(Path root, String configured) {
        Path path = Path.of(configured);
        return path.isAbsolute() ? path.normalize() : root.resolve(path).normalize();
    }

    private static void openBrowser(String url) {
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI.create(url));
            }
        } catch (Exception error) {
            System.err.println("[platform-server] browser open failed: " + error.getMessage());
        }
    }
}
