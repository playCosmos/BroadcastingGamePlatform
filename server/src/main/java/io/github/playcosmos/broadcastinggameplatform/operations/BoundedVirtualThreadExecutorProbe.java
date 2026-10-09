package io.github.playcosmos.broadcastinggameplatform.operations;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

public final class BoundedVirtualThreadExecutorProbe {
    private BoundedVirtualThreadExecutorProbe() {}

    public static void main(String[] args) throws Exception {
        var entered = new CountDownLatch(2);
        var release = new CountDownLatch(1);
        var completed = new CountDownLatch(3);
        var active = new AtomicInteger();
        var maximum = new AtomicInteger();

        try (var executor =
            new BoundedVirtualThreadExecutor(2, "bounded-probe-")) {

            Runnable blockingTask = () -> {
                int now = active.incrementAndGet();
                maximum.accumulateAndGet(now, Math::max);
                entered.countDown();
                try {
                    release.await();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                } finally {
                    active.decrementAndGet();
                    completed.countDown();
                }
            };

            executor.execute(blockingTask);
            executor.execute(blockingTask);
            require(
                entered.await(2, TimeUnit.SECONDS),
                "first two tasks must enter"
            );

            var thirdAccepted = new AtomicBoolean(false);
            Thread submitter = Thread.ofPlatform().start(() -> {
                executor.execute(() -> {
                    int now = active.incrementAndGet();
                    maximum.accumulateAndGet(now, Math::max);
                    active.decrementAndGet();
                    completed.countDown();
                });
                thirdAccepted.set(true);
            });

            Thread.sleep(150);
            require(
                !thirdAccepted.get(),
                "third submit must backpressure while capacity is full"
            );

            release.countDown();
            submitter.join(2000);
            require(
                thirdAccepted.get(),
                "third submit must resume after capacity is released"
            );
            require(
                completed.await(2, TimeUnit.SECONDS),
                "all bounded executor tasks must complete"
            );
            require(
                maximum.get() <= 2,
                "bounded executor must never exceed configured concurrency"
            );
        }

        System.out.println("Bounded virtual-thread executor probe passed.");
    }

    private static void require(
        boolean condition,
        String message
    ) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
