package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Bound subprocess stdin writes by the same deadline as synthesis. */
final class TtsProcessInput {
    private TtsProcessInput() {}

    static long remainingNanos(long deadline) {
        return Math.max(0L, deadline - System.nanoTime());
    }

    static void write(Process process, byte[] bytes, long deadline) throws Exception {
        FutureTask<Void> writing = new FutureTask<>(() -> {
            try (var stdin = process.getOutputStream()) {
                stdin.write(bytes);
                stdin.flush();
            }
            return null;
        });
        Thread writer = Thread.ofVirtual().name("platform-tts-stdin").start(writing);
        try {
            long remaining = remainingNanos(deadline);
            if (remaining == 0) throw new TimeoutException("stdin deadline expired");
            writing.get(remaining, TimeUnit.NANOSECONDS);
        } catch (TimeoutException timeout) {
            TtsProcessCleanup.terminate(process);
            writing.cancel(true);
            writer.interrupt();
            throw new IllegalStateException("TTS process input timeout", timeout);
        } catch (InterruptedException interrupted) {
            TtsProcessCleanup.terminate(process);
            writing.cancel(true);
            writer.interrupt();
            Thread.currentThread().interrupt();
            throw interrupted;
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause();
            if (cause instanceof Exception ex) throw ex;
            if (cause instanceof Error error) throw error;
            throw new IllegalStateException("TTS process input failed", cause);
        }
    }
}
