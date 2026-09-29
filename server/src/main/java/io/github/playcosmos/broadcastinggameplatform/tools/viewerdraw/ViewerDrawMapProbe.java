package io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw;

import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

public final class ViewerDrawMapProbe {
    private ViewerDrawMapProbe() {}

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory(
            "viewer-draw-map-probe-"
        );
        try {
            var database = new BoardGameDatabase(
                root.resolve("platform.db")
            );
            database.initialize();
            var service = new ViewerDrawService(database);

            var world = new ViewerDrawService.MachineWorld(
                1280,
                720,
                0,
                12
            );
            var spawn = new ViewerDrawService.MachineComponent(
                "spawn-1",
                "SPAWN",
                640,
                70,
                0,
                0,
                0,
                18,
                Map.of("marbleRadius", 11)
            );
            var wall = new ViewerDrawService.MachineComponent(
                "wall-1",
                "WALL",
                640,
                360,
                0,
                500,
                18,
                0,
                Map.of(
                    "restitution", 0.35,
                    "friction", 0.05
                )
            );
            var gate = new ViewerDrawService.MachineComponent(
                "gate-1",
                "GATE",
                320,
                300,
                0,
                180,
                16,
                0,
                Map.of(
                    "restitution", 0.35,
                    "friction", 0.05,
                    "openAngle", 78,
                    "period", 3.6
                )
            );
            var hinge = new ViewerDrawService.MachineComponent(
                "hinge-1",
                "HINGE",
                940,
                430,
                0,
                220,
                16,
                0,
                Map.of(
                    "restitution", 0.34,
                    "friction", 0.08,
                    "pivotRatio", 0,
                    "lowerAngle", -70,
                    "upperAngle", 70,
                    "jointFriction", 1.2
                )
            );
            var elevator = new ViewerDrawService.MachineComponent(
                "elevator-1",
                "ELEVATOR",
                760,
                430,
                0,
                180,
                20,
                0,
                Map.of(
                    "restitution", 0.34,
                    "friction", 0.08,
                    "axisAngle", -90,
                    "travelMin", -120,
                    "travelMax", 120,
                    "motorSpeed", 90,
                    "motorForce", 45,
                    "startDirection", 1
                )
            );
            var gearB = new ViewerDrawService.MachineComponent(
                "gear-b",
                "GEAR",
                520,
                430,
                0,
                170,
                18,
                0,
                Map.of(
                    "restitution", 0.4,
                    "friction", 0.06,
                    "motorSpeed", 120,
                    "motorTorque", 35,
                    "linkedComponentId", "",
                    "gearRatio", -1
                )
            );
            var gearA = new ViewerDrawService.MachineComponent(
                "gear-a",
                "GEAR",
                360,
                430,
                0,
                170,
                18,
                0,
                Map.of(
                    "restitution", 0.4,
                    "friction", 0.06,
                    "motorSpeed", 120,
                    "motorTorque", 35,
                    "linkedComponentId", "gear-b",
                    "gearRatio", -1
                )
            );
            var output = new ViewerDrawService.MachineComponent(
                "output-1",
                "OUTPUT",
                640,
                660,
                0,
                300,
                60,
                0,
                Map.of(
                    "outputKey", "WIN",
                    "outputRank", 1
                )
            );
            var finish = new ViewerDrawService.MachineComponent(
                "finish-1",
                "FINISH",
                640,
                660,
                0,
                300,
                60,
                0,
                Map.of()
            );

            var definition =
                new ViewerDrawService.MachineMapDefinition(
                    "viewer-draw-machine-map/v0",
                    "Probe Machine",
                    world,
                    List.of(spawn, wall, gate, hinge, finish)
                );

            require(
                service.validateMachineMap(definition).isEmpty(),
                "valid machine map must pass validation"
            );

            var saved = service.saveMachineMap(
                null,
                definition
            );
            require(
                saved.mapId() != null
                    && !saved.mapId().isBlank(),
                "saved machine map requires map id"
            );
            require(
                saved.revision() == 1,
                "new machine map revision must be 1"
            );
            require(
                saved.definitionHash() != null
                    && saved.definitionHash().length() == 64,
                "machine map hash must be SHA-256"
            );

            var updatedDefinition =
                new ViewerDrawService.MachineMapDefinition(
                    "viewer-draw-machine-map/v0",
                    "Probe Machine Updated",
                    world,
                    new ViewerDrawService.MachineDrawRule(
                        "ORDERED_OUTPUT",
                        1
                    ),
                    new ViewerDrawService.MachineRunPolicy(
                        120,
                        1,
                        5
                    ),
                    List.of(
                        spawn,
                        new ViewerDrawService.MachineComponent(
                            "wall-1",
                            "RAMP",
                            640,
                            360,
                            8,
                            500,
                            18,
                            0,
                            Map.of(
                                "restitution", 0.35,
                                "friction", 0.05
                            )
                        ),
                        gate,
                        hinge,
                        gearA,
                        gearB,
                        elevator,
                        output
                    )
                );

            var updated = service.saveMachineMap(
                saved.mapId(),
                updatedDefinition
            );
            require(
                updated.revision() == 2,
                "map update must increment revision"
            );
            require(
                !saved.definitionHash().equals(
                    updated.definitionHash()
                ),
                "physics map change must change hash"
            );
            require(
                "ORDERED_OUTPUT".equals(
                    updated.definition().drawRule().type()
                ),
                "updated map must persist draw rule"
            );
            require(
                updated.definition().runPolicy().timeoutSeconds() == 120
                    && updated.definition()
                        .runPolicy()
                        .qualificationMaxNudges() == 5,
                "updated map must persist run policy"
            );

            var revision1 = service.findMachineMapRevision(
                saved.mapId(),
                1
            );
            var revision2 = service.findMachineMapRevision(
                saved.mapId(),
                2
            );
            require(
                revision1.definitionHash().equals(
                    saved.definitionHash()
                ),
                "revision 1 hash must remain immutable"
            );
            require(
                "Probe Machine".equals(
                    revision1.definition().name()
                ),
                "revision 1 definition must remain immutable"
            );
            require(
                revision2.definitionHash().equals(
                    updated.definitionHash()
                ),
                "revision 2 hash must match updated map"
            );
            require(
                "Probe Machine Updated".equals(
                    service.findMachineMap(saved.mapId()).name()
                ),
                "saved map must reload"
            );
            require(
                service.recentMachineMaps(10).size() == 1,
                "recent maps must contain saved map"
            );

            var slot = new ViewerDrawService.MachineComponent(
                "slot-1",
                "SLOT",
                640,
                660,
                0,
                420,
                80,
                0,
                Map.of(
                    "slotKey", "A",
                    "slotCapacity", 2,
                    "soundMaterial", "wood",
                    "instrument", "xylophone",
                    "audioNote", 64,
                    "audioGain", 1.2,
                    "audioPan", -0.2
                )
            );
            var elimination =
                new ViewerDrawService.MachineComponent(
                    "elimination-1",
                    "ELIMINATION",
                    640,
                    650,
                    0,
                    500,
                    100,
                    0,
                    Map.of(
                        "eliminationKey", "PIT",
                        "soundMaterial", "stone",
                        "instrument", "drum",
                        "audioNote", 40
                    )
                );
            var cascadeOutput =
                new ViewerDrawService.MachineComponent(
                    "cascade-output",
                    "OUTPUT",
                    640,
                    660,
                    0,
                    420,
                    80,
                    0,
                    Map.of(
                        "outputKey", "CASCADE",
                        "outputRank", 1,
                        "outputCapacity", 2,
                        "outputWeight", 1
                    )
                );

            var slotDefinition =
                new ViewerDrawService.MachineMapDefinition(
                    "viewer-draw-machine-map/v0",
                    "Slot Probe",
                    world,
                    new ViewerDrawService.MachineDrawRule(
                        "SLOT_COLLECTION",
                        2
                    ),
                    List.of(spawn, slot)
                );
            require(
                service.validateMachineMap(slotDefinition).isEmpty(),
                "slot collection map must pass server validation"
            );

            var survivorDefinition =
                new ViewerDrawService.MachineMapDefinition(
                    "viewer-draw-machine-map/v0",
                    "Survivor Probe",
                    world,
                    new ViewerDrawService.MachineDrawRule(
                        "LAST_SURVIVOR",
                        1
                    ),
                    List.of(spawn, elimination)
                );
            require(
                service.validateMachineMap(survivorDefinition).isEmpty(),
                "last survivor map must pass server validation"
            );

            var cascadeDefinition =
                new ViewerDrawService.MachineMapDefinition(
                    "viewer-draw-machine-map/v0",
                    "Cascade Probe",
                    world,
                    new ViewerDrawService.MachineDrawRule(
                        "CASCADE_SELECTION",
                        2
                    ),
                    List.of(spawn, cascadeOutput)
                );
            require(
                service.validateMachineMap(cascadeDefinition).isEmpty(),
                "cascade map must pass server validation"
            );

            var bucketA = new ViewerDrawService.MachineComponent(
                "bucket-a",
                "OUTPUT",
                500,
                660,
                0,
                220,
                80,
                0,
                Map.of(
                    "outputKey", "A",
                    "outputRank", 1,
                    "outputCapacity", 1,
                    "outputWeight", 1
                )
            );
            var bucketB = new ViewerDrawService.MachineComponent(
                "bucket-b",
                "OUTPUT",
                780,
                660,
                0,
                220,
                80,
                0,
                Map.of(
                    "outputKey", "B",
                    "outputRank", 1,
                    "outputCapacity", 1,
                    "outputWeight", 3
                )
            );
            var randomBucketDefinition =
                new ViewerDrawService.MachineMapDefinition(
                    "viewer-draw-machine-map/v0",
                    "Random Bucket Probe",
                    world,
                    new ViewerDrawService.MachineDrawRule(
                        "RANDOM_OUTPUT_BUCKET",
                        1
                    ),
                    List.of(spawn, bucketA, bucketB)
                );
            require(
                service.validateMachineMap(
                    randomBucketDefinition
                ).isEmpty(),
                "random bucket map must pass server validation"
            );

            var conditionalA =
                new ViewerDrawService.MachineComponent(
                    "conditional-a",
                    "OUTPUT",
                    600,
                    660,
                    0,
                    220,
                    80,
                    0,
                    Map.of(
                        "outputKey", "A",
                        "outputRank", 1,
                        "outputCapacity", 1,
                        "outputWeight", 1,
                        "outputPriority", 10,
                        "conditionType", "ALWAYS",
                        "conditionClaims", 1
                    )
                );
            var conditionalB =
                new ViewerDrawService.MachineComponent(
                    "conditional-b",
                    "OUTPUT",
                    680,
                    660,
                    0,
                    220,
                    80,
                    0,
                    Map.of(
                        "outputKey", "B",
                        "outputRank", 2,
                        "outputCapacity", 1,
                        "outputWeight", 1,
                        "outputPriority", 20,
                        "conditionType", "AFTER_OUTPUT_FULL",
                        "conditionOutputKey", "A",
                        "conditionClaims", 1
                    )
                );
            var conditionalDefinition =
                new ViewerDrawService.MachineMapDefinition(
                    "viewer-draw-machine-map/v0",
                    "Conditional Probe",
                    world,
                    new ViewerDrawService.MachineDrawRule(
                        "CONDITIONAL_OUTPUT",
                        2
                    ),
                    new ViewerDrawService.MachineRunPolicy(
                        30,
                        2,
                        4
                    ),
                    List.of(
                        spawn,
                        conditionalA,
                        conditionalB
                    )
                );
            require(
                service.validateMachineMap(
                    conditionalDefinition
                ).isEmpty(),
                "conditional output map must pass server validation"
            );

            var cycleA =
                new ViewerDrawService.MachineComponent(
                    "cycle-a",
                    "OUTPUT",
                    600,
                    660,
                    0,
                    220,
                    80,
                    0,
                    Map.of(
                        "outputKey", "A",
                        "outputRank", 1,
                        "outputCapacity", 1,
                        "outputWeight", 1,
                        "conditionType", "AFTER_OUTPUT_FULL",
                        "conditionOutputKey", "B",
                        "conditionClaims", 1
                    )
                );
            var cycleB =
                new ViewerDrawService.MachineComponent(
                    "cycle-b",
                    "OUTPUT",
                    680,
                    660,
                    0,
                    220,
                    80,
                    0,
                    Map.of(
                        "outputKey", "B",
                        "outputRank", 2,
                        "outputCapacity", 1,
                        "outputWeight", 1,
                        "conditionType", "AFTER_OUTPUT_FULL",
                        "conditionOutputKey", "A",
                        "conditionClaims", 1
                    )
                );
            var cycleDefinition =
                new ViewerDrawService.MachineMapDefinition(
                    "viewer-draw-machine-map/v0",
                    "Conditional Cycle Probe",
                    world,
                    new ViewerDrawService.MachineDrawRule(
                        "CONDITIONAL_OUTPUT",
                        2
                    ),
                    List.of(spawn, cycleA, cycleB)
                );
            require(
                !service.validateMachineMap(
                    cycleDefinition
                ).isEmpty(),
                "conditional output cycle must fail server validation"
            );

            var invalid =
                new ViewerDrawService.MachineMapDefinition(
                    "viewer-draw-machine-map/v0",
                    "Invalid",
                    world,
                    List.of(spawn)
                );
            require(
                !service.validateMachineMap(invalid).isEmpty(),
                "map without FINISH must fail validation"
            );

            boolean rejected = false;
            try {
                service.saveMachineMap(null, invalid);
            } catch (IllegalArgumentException expected) {
                rejected = true;
            }
            require(
                rejected,
                "invalid map save must be rejected"
            );

            service.archiveMachineMap(saved.mapId());
            require(
                service.recentMachineMaps(10).isEmpty(),
                "archived map must leave active map list"
            );

            System.out.println(
                "Viewer Draw map probe passed."
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
