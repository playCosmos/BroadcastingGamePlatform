package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Persistent operator policy and disabled-by-default worker probe. */
public final class PiperRuntimeSettingsProbe {
    private PiperRuntimeSettingsProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("piper-runtime-policy-");
        try {
            var absentPython = new PiperRuntimeSettingsStore(root, false);
            require(!absentPython.get().enabled()
                && absentPython.get().idleSeconds() == 60,
                "unconfigured host defaults to disabled, 60-second idle");
            reject(() -> absentPython.save(
                new PiperRuntimeSettingsStore.Settings(true, 60)),
                "unconfigured host may not enable model residency");
            for (int seconds : List.of(-1, 0, 9, 601, 10000)) {
                reject(() -> new PiperRuntimeSettingsStore.Settings(false, seconds),
                    "idleSeconds must stay within range");
            }
            absentPython.save(new PiperRuntimeSettingsStore.Settings(false, 120));
            Path policy = root.resolve("tts/piper-runtime.json");
            require(Files.exists(policy), "operator policy must persist");
            var restarted = new PiperRuntimeSettingsStore(root, true);
            require(!restarted.get().enabled()
                && restarted.get().idleSeconds() == 120,
                "saved policy overrides newly available host Python");
            restarted.save(new PiperRuntimeSettingsStore.Settings(true, 45));
            var persisted = new PiperRuntimeSettingsStore(root, true);
            require(persisted.get().enabled() && persisted.get().idleSeconds() == 45,
                "enabled mode and idle timeout survive restarts");

            Path javaExe = Path.of(System.getProperty("java.home"), "bin",
                System.getProperty("os.name", "").toLowerCase().contains("win")
                    ? "java.exe" : "java").toAbsolutePath();
            var engine = new PiperEngine(root.resolve("tts/voices"), null, javaExe);
            require(engine.runtime().available() && engine.runtime().enabled()
                && engine.runtime().idleSeconds() == 45,
                "operator settings should select opt-in worker at startup");
            var disabled = engine.configureRuntime(false, 90);
            require(!disabled.enabled() && "DISABLED".equals(disabled.state()),
                "disabling worker must release its process and retain policy");
            engine.configureRuntime(true, 10);
            require(engine.runtime().enabled() && !engine.runtime().invalidSettings(),
                "configured environment can re-enable Piper worker");
            engine.releaseRuntime();
            require(!engine.warmWorkerRunning(),
                "explicit release must not spin up the native subprocess");
            engine.close();
            reject(() -> engine.configureRuntime(true, 30),
                "closed engine must reject reconfiguration");

            Files.writeString(policy, "{broken", StandardCharsets.UTF_8);
            var corrupt = new PiperRuntimeSettingsStore(root, true);
            require(corrupt.invalid() && !corrupt.get().enabled(),
                "corrupt operator policy must fail closed");
            reject(() -> corrupt.save(
                new PiperRuntimeSettingsStore.Settings(true, 60)),
                "broken file cannot be silently overwritten");
            require("{broken".equals(Files.readString(policy)),
                "invalid policy preserved for manual repair");
            System.out.println("Piper runtime settings persistence and fail-closed probe passed.");
        } finally {
            try (var files = Files.walk(root)) {
                files.sorted((a, b) -> b.compareTo(a)).forEach(path -> {
                    try { Files.deleteIfExists(path); }
                    catch (Exception ignored) {}
                });
            }
        }
    }

    private interface Action { void run() throws Exception; }
    private static void reject(Action action, String message) throws Exception {
        try { action.run(); }
        catch (IllegalArgumentException | IllegalStateException expected) { return; }
        throw new IllegalStateException("expected rejection: " + message);
    }
    private static void require(boolean ok, String message) {
        if (!ok) throw new IllegalStateException(message);
    }
}
