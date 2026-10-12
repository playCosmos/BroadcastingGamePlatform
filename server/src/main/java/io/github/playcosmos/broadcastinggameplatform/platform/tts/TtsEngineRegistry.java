package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.ServiceLoader;
import java.util.ServiceConfigurationError;

/**
 * Load additional trusted classpath TTS providers via standard Java SPI.
 * Does not download, execute, or auto-install voice packs from disk/network.
 */
public final class TtsEngineRegistry {
    private TtsEngineRegistry() {}

    public static List<TtsService.TtsEngine> installed() {
        var engines = new ArrayList<TtsService.TtsEngine>();
        engines.add(new WindowsSapiEngine());
        var ids = new HashSet<String>();
        ids.add("windows-sapi");
        try {
            for (TtsService.TtsEngine candidate :
                ServiceLoader.load(TtsService.TtsEngine.class)) {
                if (candidate == null
                    || candidate.id() == null
                    || !candidate.id().matches("[a-z0-9][a-z0-9-]{1,63}")) {
                    System.err.println("[tts] ignored invalid SPI engine");
                    continue;
                }
                if (!ids.add(candidate.id())) {
                    System.err.println("[tts] ignored duplicate SPI engine id");
                    continue;
                }
                engines.add(candidate);
            }
        } catch (ServiceConfigurationError | RuntimeException error) {
            // A broken optional provider cannot prevent the platform starting.
            System.err.println("[tts] optional provider discovery failed: "
                + error.getClass().getSimpleName());
        }
        return List.copyOf(engines);
    }
}
