package io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw.physics;

import io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw.ViewerDrawService;
import java.util.List;

public interface MarblePhysicsAdapter {
    String engineId();

    String engineVersion();

    SimulationResult simulate(
        ViewerDrawService.MachineMapDefinition definition,
        long seed,
        int marbleCount,
        double timeoutSeconds
    );

    record MarbleState(
        String marbleId,
        double x,
        double y,
        boolean finished,
        int rank,
        Double finishTimeSeconds
    ) {}

    record SimulationResult(
        String engineId,
        String engineVersion,
        long seed,
        double fixedTimeStepSeconds,
        long stepCount,
        double simulatedSeconds,
        boolean timedOut,
        List<String> finishOrder,
        List<MarbleState> marbles
    ) {}
}
