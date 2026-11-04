package io.github.playcosmos.broadcastinggameplatform.platform.tts;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
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
        return installed(null);
    }

    public static List<TtsService.TtsEngine> installed(java.nio.file.Path applicationRoot) {
        return installed(applicationRoot, applicationRoot == null ? null
            : new TtsVoicePackStore(applicationRoot));
    }

    public static List<TtsService.TtsEngine> installed(java.nio.file.Path applicationRoot,
                                                       TtsVoicePackStore packStore) {
        var engines = new ArrayList<TtsService.TtsEngine>();
        engines.add(new WindowsSapiEngine());
        engines.add(new EspeakNgEngine());
        if (applicationRoot != null) {
            engines.add(new PiperEngine(applicationRoot.resolve("tts/voices"), packStore));
        }
        var ids = new HashSet<String>();
        for (var engine : engines) ids.add(engine.id());
        // Handle each SPI entry individually: one broken native adapter must
        // not suppress otherwise healthy providers later in the manifest.
        Iterator<TtsService.TtsEngine> providers =
            ServiceLoader.load(TtsService.TtsEngine.class).iterator();
        int consecutiveFailures = 0;
        while (true) {
            TtsService.TtsEngine candidate;
            try {
                if (!providers.hasNext()) break;
                candidate = providers.next();
                consecutiveFailures = 0;
            } catch (ServiceConfigurationError | RuntimeException | LinkageError error) {
                System.err.println("[tts] optional provider load failed: "
                    + error.getClass().getSimpleName());
                // A malformed descriptor may throw repeatedly without advancing.
                if (++consecutiveFailures >= 8) break;
                continue;
            }
            try {
                String id = candidate == null ? null : candidate.id();
                if (id == null || !id.matches("[a-z0-9][a-z0-9-]{1,63}")) {
                    System.err.println("[tts] ignored invalid SPI engine");
                    continue;
                }
                if (!ids.add(id)) {
                    System.err.println("[tts] ignored duplicate SPI engine id");
                    continue;
                }
                engines.add(candidate);
            } catch (RuntimeException | LinkageError error) {
                System.err.println("[tts] optional provider metadata failed: "
                    + error.getClass().getSimpleName());
            }
        }
        return List.copyOf(engines);
    }
}
