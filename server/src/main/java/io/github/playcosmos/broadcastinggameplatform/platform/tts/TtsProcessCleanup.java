package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.util.Comparator;
import java.util.concurrent.TimeUnit;

/** Best-effort bounded shutdown of optional local TTS subprocess trees. */
final class TtsProcessCleanup {
    private TtsProcessCleanup() {}

    static void terminate(Process process) {
        if (process == null) return;
        // Snapshot children before killing the parent: reparented processes
        // may no longer be visible in descendants() after parent exit.
        var descendants = process.toHandle().descendants()
            .sorted(Comparator.comparingLong(ProcessHandle::pid).reversed())
            .toList();
        for (var child : descendants) {
            try { if (child.isAlive()) child.destroyForcibly(); }
            catch (SecurityException ignored) { /* best effort */ }
        }
        if (process.isAlive()) process.destroyForcibly();
        try {
            process.waitFor(2, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
