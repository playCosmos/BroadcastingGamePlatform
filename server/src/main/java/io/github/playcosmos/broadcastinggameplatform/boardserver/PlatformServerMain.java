package io.github.playcosmos.broadcastinggameplatform.boardserver;

import com.google.gson.Gson;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application.DrawingGuessGameService;
import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.persistence.DrawingGuessRepository;
import io.github.playcosmos.broadcastinggameplatform.operations.FileLog;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChatMessageEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.events.DonationEvent;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.ProviderRegistry;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.SoopBroadcastProvider;
import io.github.playcosmos.broadcastinggameplatform.platform.provider.SoopProviderConfig;
import io.github.playcosmos.broadcastinggameplatform.operations.WindowsConsoleEncoding;
import io.github.playcosmos.broadcastinggameplatform.room.BoardGameRuntimeEngine;
import io.github.playcosmos.broadcastinggameplatform.room.RoomHttpHandler;
import io.github.playcosmos.broadcastinggameplatform.room.RoomService;
import io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw.ViewerDrawService;
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

        var drawingSync = new DrawingSyncService(database);
        var drawingRepository = new DrawingGuessRepository(database);
        var drawingGame = new DrawingGuessGameService(
            drawingRepository,
            drawingSync
        );
        var drawingRecovery = drawingGame.recoverAfterRestart();
        if (
            drawingRecovery.activeRounds() > 0
            || drawingRecovery.expiredRounds() > 0
        ) {
            System.out.println(
                "[drawing-guess] recovery active="
                    + drawingRecovery.activeRounds()
                    + " restoredCanvas="
                    + drawingRecovery.restoredCanvasSessions()
                    + " recreatedCanvas="
                    + drawingRecovery.recreatedCanvasSessions()
                    + " expiredRounds="
                    + drawingRecovery.expiredRounds()
            );
        }

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
            },
            drawingSync
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

        lifecycleExecutor.scheduleAtFixedRate(() -> {
            try {
                int expired = drawingGame.expireTimedOutRounds();
                if (expired > 0) {
                    System.out.println(
                        "[drawing-guess] auto-completed expired rounds="
                            + expired
                    );
                }
            } catch (Exception error) {
                System.err.println(
                    "[drawing-guess] expiry scan failed: "
                        + error.getMessage()
                );
            }
        }, 1, 1, TimeUnit.SECONDS);

        var roomHttp = new RoomHttpHandler(roomService, runtime);

        var platformEvents = new PlatformEventBus();
        var providers = new ProviderRegistry();
        var soop = new SoopBroadcastProvider(
            new SoopProviderConfig(
                config.streamerId(),
                config.soop().enabled(),
                config.soop().offlinePollSeconds()
            ).normalized(),
            platformEvents
        );
        providers.register(soop);

        var boardDonationSubscription = platformEvents.subscribe(
            DonationEvent.class,
            donation -> {
                if (!SoopBroadcastProvider.ID.equals(donation.provider())) {
                    return;
                }
                try {
                    var result = runtime.process(donation);
                    if (
                        result.processedRooms() > 0 ||
                        result.duplicateRooms() > 0 ||
                        result.queuedRooms() > 0 ||
                        result.ignoredRooms() > 0
                    ) {
                        System.out.println(
                            "[board-game] provider=" + donation.provider()
                                + " donor=" + donation.userId()
                                + " amount=" + donation.amount()
                                + " matched=" + result.matchedRooms()
                                + " processed=" + result.processedRooms()
                                + " queued=" + result.queuedRooms()
                                + " ignored=" + result.ignoredRooms()
                                + " duplicates=" + result.duplicateRooms()
                        );
                    }
                } catch (Exception error) {
                    System.err.println(
                        "[board-game] donation processing failed: "
                            + error.getMessage()
                    );
                    error.printStackTrace(System.err);
                }
            }
        );

        var viewerDraw = new ViewerDrawService(database);
        var drawingChatSubscription = platformEvents.subscribe(
            ChatMessageEvent.class,
            chat -> {
                try {
                    var result = drawingGame.processChatMessage(chat);
                    if (
                        result.correct()
                        || "AMBIGUOUS_ROOM_BINDING".equals(
                            result.status()
                        )
                    ) {
                        System.out.println(
                            "[drawing-guess] chat status="
                                + result.status()
                                + " provider=" + chat.provider()
                                + " user=" + chat.userId()
                                + " room=" + result.roomId()
                                + " round=" + result.roundId()
                                + " rank=" + result.rank()
                                + " score=" + result.guesserScore()
                        );
                    }
                } catch (Exception error) {
                    System.err.println(
                        "[drawing-guess] chat processing failed: "
                            + error.getMessage()
                    );
                }
            }
        );

        var adminAuthStore = new AdminAuthStore(database);
        var clientHttp = new GameClientHttpServer(
            config,
            root,
            roomService,
            runtime,
            adminAuthStore,
            platformEvents,
            providers,
            viewerDraw,
            drawingSync,
            drawingGame
        );
        var http = new BoardGameHttpServer(
            config,
            root,
            database.path(),
            websocket::connectedClients,
            soop::snapshot,
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
            soop::reconnect
        );
        http.start();
        clientHttp.start();
        providers.startAll();

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
            try { boardDonationSubscription.close(); } catch (Exception ignored) {}
            try { drawingChatSubscription.close(); } catch (Exception ignored) {}
            try { providers.close(); } catch (Exception ignored) {}
            try { fileLog.close(); } catch (Exception ignored) {}
            shutdown.countDown();
        };

        Runnable explicitExit = () -> {
            Thread.ofPlatform().daemon(true).name("platform-server-exit-watchdog").start(() -> {
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
            soop::status,
            soop::reconnect,
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
