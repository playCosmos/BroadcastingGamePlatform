package io.github.playcosmos.broadcastinggameplatform.platform.provider;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardServerConfig;
import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardServerConfigLoader;
import io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBus;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

/** No live SOOP network needed: source budgets, isolated lifecycle and config. */
public final class SoopMultiProviderR12bProbe {
    private static int checks;
    private SoopMultiProviderR12bProbe() {}

    public static void main(String[] args) throws Exception {
        var events = new PlatformEventBus();
        var registry = new ProviderRegistry();
        var source = new SoopMultiBroadcastProvider(
            "primary", List.of("other-a", "other-b"), false, 30, events);
        try {
            check(source.configuredStreamers().equals(
                List.of("primary", "other-a", "other-b")),
                "stable per-source ordering");
            registry.register(source);
            registry.startAll();
            registry.startAll();
            var snapshot = source.snapshot();
            check("primary".equals(snapshot.get("streamerId")),
                "legacy primary identity is unchanged");
            check("DISABLED".equals(snapshot.get("status")),
                "legacy disabled primary status is preserved");
            check((Integer)snapshot.get("configuredStreams")==3,
                "three independent source supervisors configured");
            check(((Number)snapshot.get("connectedStreams")).intValue()==0,
                "disabled provider makes no live connections");
            check("DISABLED".equals(snapshot.get("aggregateStatus")),
                "disabled streams preserve aggregate health");
            @SuppressWarnings("unchecked")
            var streams=(List<Map<String,Object>>)snapshot.get("streams");
            check(streams.size()==3 &&
                streams.stream().map(x->(String)x.get("streamerId")).toList()
                    .equals(source.configuredStreamers()),
                "diagnostics expose every configured streamer individually");
            check(Boolean.TRUE.equals(streams.get(0).get("primary"))
                && Boolean.FALSE.equals(streams.get(1).get("primary")),
                "one primary and independent secondary sessions");
            check(registry.snapshots().size()==1,
                "single SOOP provider registry entry remains backward compatible");
            check(((Number)registry.snapshots().get(0).get("configuredStreams"))
                .intValue()==3,"administrator provider diagnostics include sources");
            registry.reconnect("SOOP");
            source.reconnect("other-b");
            check("DISABLED".equals(source.status()),
                "manual reconnect never starts a disabled connection");
            invalid(()->source.reconnect("unknown"),"unknown source is rejected");
        } finally {
            registry.close();
            source.close();
        }

        var onlyExtra = new SoopMultiBroadcastProvider(
            "", List.of("guestless-a","guestless-b"), false, 30, events);
        try {
            onlyExtra.start();
            check(onlyExtra.configuredStreamers().size()==2,
                "additional streams work with empty legacy primary");
            check(((Number)onlyExtra.snapshot().get("connectedStreams")).intValue()==0,
                "empty primary causes no implicit provider connection");
        } finally { onlyExtra.close(); }

        var single = new SoopMultiBroadcastProvider(
            "legacy", List.of(), false, 30, events);
        try {
            single.start();
            check(single.configuredStreamers().equals(List.of("legacy")),
                "single-source legacy installation unchanged");
            check(single.status().equals(single.snapshot().get("status")),
                "single-source tray status remains legacy status");
        } finally { single.close(); }

        invalid(()->new SoopMultiBroadcastProvider("dup",
            List.of("dup"),false,30,events),
            "primary ID cannot be configured twice");
        invalid(()->new SoopMultiBroadcastProvider("primary",
            List.of("extra","extra"),false,30,events),
            "secondary IDs must be unique");
        invalid(()->new SoopMultiBroadcastProvider("primary",
            List.of("invalid id!"),false,30,events),
            "untrusted channel format is rejected");
        invalid(()->new SoopMultiBroadcastProvider("primary",
            List.of("a","b","c","d","e","f","g","h"),false,30,events),
            "connection budget includes primary");

        var defaults=BoardServerConfig.defaults();
        var config=new BoardServerConfig("primary", defaults.server(),
            defaults.storage(),new BoardServerConfig.Soop(
                false,30,List.of(" a ","b"))).normalized();
        check(config.soop().additionalStreamerIds().equals(List.of("a","b")),
            "trusted IDs normalized before persistence");
        invalid(()->new BoardServerConfig("primary",defaults.server(),
            defaults.storage(),new BoardServerConfig.Soop(
                false,30,List.of("primary"))).normalized(),
            "config normalization rejects duplicate primary");
        invalid(()->new BoardServerConfig("primary",defaults.server(),
            defaults.storage(),new BoardServerConfig.Soop(
                false,30,List.of("1","2","3","4","5","6","7","8"))).normalized(),
            "server rejects more than eight configured sources");

        var dir=Files.createTempDirectory("soop-r12b-config-");
        try {
            var file=dir.resolve("config.json");
            BoardServerConfigLoader.save(file,config);
            var loaded=BoardServerConfigLoader.loadOrCreate(file);
            check(loaded.soop().additionalStreamerIds().equals(List.of("a","b")),
                "multi-source configuration persists and restores");
            check(!loaded.soop().enabled(),"disabled state round-trips");
        } finally {
            try(var files=Files.walk(dir)) {
                files.sorted((x,y)->y.compareTo(x)).forEach(x->{
                    try {Files.deleteIfExists(x);}catch(Exception ignored){}
                });
            }
        }
        System.out.println("SOOP_MULTI_SOURCE_R12B_PASSED checks="+checks+
            " budget=8 connection_state=isolated offline_network=true"+
            " legacy=compatible config=durable");
    }
    @FunctionalInterface private interface Action { void run() throws Exception; }
    private static void invalid(Action work,String name) throws Exception {
        checks++;
        try {work.run();} catch(IllegalArgumentException expected){return;}
        throw new AssertionError(name);
    }
    private static void check(boolean ok,String name) {
        checks++;
        if(!ok)throw new AssertionError(name);
    }
}
