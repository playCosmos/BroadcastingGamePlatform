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
                    List.of(spawn, wall, finish)
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
                        finish
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
