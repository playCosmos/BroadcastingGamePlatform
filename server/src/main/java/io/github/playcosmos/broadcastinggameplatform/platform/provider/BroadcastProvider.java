package io.github.playcosmos.broadcastinggameplatform.platform.provider;

import java.util.Map;

public interface BroadcastProvider extends AutoCloseable {
    String id();
    void start();
    void reconnect();
    Map<String, Object> snapshot();

    @Override
    void close();
}
