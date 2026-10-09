package io.github.playcosmos.broadcastinggameplatform.operations;

import java.util.Objects;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Runs each HTTP exchange on a virtual thread while bounding how many
 * exchanges may execute concurrently. When saturated, the HttpServer
 * dispatcher blocks at execute(), providing backpressure instead of
 * accumulating an unbounded task queue or unbounded virtual threads.
 */
public final class BoundedVirtualThreadExecutor
    implements Executor, AutoCloseable {
    private final Semaphore permits;
    private final ExecutorService delegate;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public BoundedVirtualThreadExecutor(
        int maxConcurrency,
        String threadPrefix
    ) {
        if (maxConcurrency < 1) {
            throw new IllegalArgumentException(
                "maxConcurrency must be positive"
            );
        }
        permits = new Semaphore(maxConcurrency);
        delegate = Executors.newThreadPerTaskExecutor(
            Thread.ofVirtual()
                .name(
                    threadPrefix == null || threadPrefix.isBlank()
                        ? "bounded-http-"
                        : threadPrefix,
                    0
                )
                .factory()
        );
    }

    @Override
    public void execute(Runnable command) {
        Objects.requireNonNull(command, "command");
        if (closed.get()) {
            throw new java.util.concurrent.RejectedExecutionException(
                "executor is closed"
            );
        }

        permits.acquireUninterruptibly();
        if (closed.get()) {
            permits.release();
            throw new java.util.concurrent.RejectedExecutionException(
                "executor is closed"
            );
        }

        try {
            delegate.execute(() -> {
                try {
                    command.run();
                } finally {
                    permits.release();
                }
            });
        } catch (RuntimeException error) {
            permits.release();
            throw error;
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        delegate.shutdownNow();
    }
}
