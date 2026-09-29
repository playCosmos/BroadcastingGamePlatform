package io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw.physics.JBox2dMarblePhysicsAdapter;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

public final class ViewerDrawProductionPhysicsProbe {
    private ViewerDrawProductionPhysicsProbe() {}

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory(
            "viewer-draw-production-physics-probe-"
        );

        try {
            var database = new BoardGameDatabase(
                root.resolve("platform.db")
            );
            database.initialize();

            var service = new ViewerDrawService(database);

            var definition =
                new ViewerDrawService.MachineMapDefinition(
                    "viewer-draw-machine-map/v0",
                    "Production Physics Probe",
                    new ViewerDrawService.MachineWorld(
                        800,
                        600,
                        0,
                        12
                    ),
                    List.of(
                        new ViewerDrawService.MachineComponent(
                            "spawn-1",
                            "SPAWN",
                            400,
                            55,
                            0,
                            0,
                            0,
                            16,
                            Map.of("marbleRadius", 10)
                        ),
                        new ViewerDrawService.MachineComponent(
                            "wall-side",
                            "WALL",
                            100,
                            250,
                            12,
                            140,
                            14,
                            0,
                            Map.of(
                                "restitution", 0.35,
                                "friction", 0.05
                            )
                        ),
                        new ViewerDrawService.MachineComponent(
                            "ramp-side",
                            "RAMP",
                            700,
                            330,
                            -12,
                            140,
                            14,
                            0,
                            Map.of(
                                "restitution", 0.30,
                                "friction", 0.05
                            )
                        ),
                        new ViewerDrawService.MachineComponent(
                            "peg-side",
                            "PEG",
                            140,
                            420,
                            0,
                            0,
                            0,
                            12,
                            Map.of(
                                "restitution", 0.55,
                                "friction", 0.03
                            )
                        ),
                        new ViewerDrawService.MachineComponent(
                            "bumper-side",
                            "BUMPER",
                            660,
                            430,
                            0,
                            0,
                            0,
                            22,
                            Map.of(
                                "restitution", 0.95,
                                "friction", 0.02,
                                "boost", 1.15
                            )
                        ),
                        new ViewerDrawService.MachineComponent(
                            "finish-1",
                            "FINISH",
                            400,
                            535,
                            0,
                            520,
                            90,
                            0,
                            Map.of()
                        )
                    )
                );

            var saved = service.saveMachineMap(
                null,
                definition
            );

            var first = service.simulateMachineMap(
                saved.mapId(),
                42L,
                8,
                10.0
            );
            var second = service.simulateMachineMap(
                saved.mapId(),
                42L,
                8,
                10.0
            );

            require(
                JBox2dMarblePhysicsAdapter.ENGINE_ID.equals(
                    first.engineId()
                ),
                "production engine must be JBOX2D"
            );
            require(
                first.engineVersion().equals(
                    JBox2dMarblePhysicsAdapter.ENGINE_VERSION
                ),
                "production engine version mismatch"
            );
            require(
                first.mapRevision() == saved.revision()
                    && first.mapHash().equals(
                        saved.definitionHash()
                    ),
                "production simulation must bind map revision/hash"
            );
            require(
                first.result().finishOrder().size() == 8,
                "all production probe marbles must finish"
            );
            require(
                !first.result().timedOut(),
                "production probe must not time out"
            );
            require(
                first.result().finishOrder().equals(
                    second.result().finishOrder()
                ),
                "same seed/map must preserve finish order on same engine"
            );
            require(
                first.result().stepCount()
                    == second.result().stepCount(),
                "same seed/map must preserve step count"
            );
            require(
                first.result().marbles().stream().allMatch(
                    marble ->
                        marble.finished()
                            && marble.rank() > 0
                            && marble.finishTimeSeconds() != null
                ),
                "final marble states must contain finish evidence"
            );

            boolean rejected = false;
            try {
                service.simulateMachineMap(
                    saved.mapId(),
                    1L,
                    129,
                    10.0
                );
            } catch (IllegalArgumentException expected) {
                rejected = true;
            }
            require(
                rejected,
                "production adapter must enforce marble count limit"
            );

            System.out.println(
                "Viewer Draw production physics probe passed."
            );
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted((a, b) -> b.compareTo(a))
                    .forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (Exception ignored) {}
                    });
            }
        }
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
