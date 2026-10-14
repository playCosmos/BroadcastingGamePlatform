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
            .sorted(Comparator.comparingInt(TtsProcessCleanup::depth).reversed())
            .toList();
        for (var child : descendants) {
            try { if (child.isAlive()) child.destroyForcibly(); }
            catch (SecurityException ignored) { /* best effort */ }
        }
        if (process.isAlive()) process.destroyForcibly();
        // One shared wait budget for the process and all observed descendants.
        // This avoids leaving living children after a parent exits quickly.
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        try {
            long remaining = Math.max(0L, deadline - System.nanoTime());
            if (remaining > 0) process.waitFor(remaining, TimeUnit.NANOSECONDS);
            while (System.nanoTime() < deadline
                && descendants.stream().anyMatch(ProcessHandle::isAlive)) {
                Thread.sleep(20);
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static int depth(ProcessHandle child) {
        int result = 0;
        for (var parent = child.parent();
             parent.isPresent() && result < 64;
             parent = parent.get().parent()) {
            result++;
        }
        return result;
    }
}
