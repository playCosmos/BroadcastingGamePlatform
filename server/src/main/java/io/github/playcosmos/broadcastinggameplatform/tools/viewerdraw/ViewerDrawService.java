package io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import io.github.playcosmos.broadcastinggameplatform.db.DatabaseAccess;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;

public final class ViewerDrawService {
    private static final Gson GSON = new Gson();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String RNG_ALGORITHM = "java.security.SecureRandom + Fisher-Yates";
    private static final int MAX_ENTRIES = 10000;
    private static final int MAX_NUMBER = 999;
    private static final int MAX_NUMBER_DRAW_COUNT = 7;

    private final DatabaseAccess database;

    public ViewerDrawService(DatabaseAccess database) {
        this.database = database;
    }

    public record DrawEntry(
        String entryId,
        String provider,
        String userId,
        String displayName,
        String label
    ) {}

    public record Session(
        String sessionId,
        String publicCode,
        String name,
        String mode,
        String entrySource,
        String state,
        Map<String, Object> config,
        String frozenEntryHash,
        int entryCount,
        String createdAt,
        String updatedAt,
        String completedAt,
        List<DrawEntry> entries,
        Object result
    ) {}

    public record MachineWorld(
        double width,
        double height,
        double gravityX,
        double gravityY
    ) {}

    public record MachineComponent(
        String id,
        String type,
        double x,
        double y,
        double rotation,
        double width,
        double height,
        double radius,
        Map<String, Object> properties
    ) {}

    public record MachineDrawRule(
        String type,
        int winnerCount
    ) {}

    public record MachineRunPolicy(
        double timeoutSeconds,
        int qualificationMinWinners,
        int qualificationMaxNudges
    ) {}

    public record MachineMapDefinition(
        String schemaVersion,
        String name,
        MachineWorld world,
        MachineDrawRule drawRule,
        MachineRunPolicy runPolicy,
        List<MachineComponent> components
    ) {
        public MachineMapDefinition(
            String schemaVersion,
            String name,
            MachineWorld world,
            List<MachineComponent> components
        ) {
            this(
                schemaVersion,
                name,
                world,
                new MachineDrawRule("RACE_FINISH", 0),
                new MachineRunPolicy(0, 0, 0),
                components
            );
        }

        public MachineMapDefinition(
            String schemaVersion,
            String name,
            MachineWorld world,
            MachineDrawRule drawRule,
            List<MachineComponent> components
        ) {
            this(
                schemaVersion,
                name,
                world,
                drawRule,
                new MachineRunPolicy(0, 0, 0),
                components
            );
        }
    }

    public record MachineMap(
        String mapId,
        String name,
        int revision,
        String status,
        String schemaVersion,
        String definitionHash,
        String createdAt,
        String updatedAt,
        MachineMapDefinition definition
    ) {}

    public record MachineMapRevision(
        String mapId,
        int revision,
        String schemaVersion,
        String definitionHash,
        String createdAt,
        MachineMapDefinition definition
    ) {}

    public record MarbleAuditSummary(
        String auditId,
        String publicCode,
        String resultStatus,
        String qualificationStatus,
        String mapName,
        String definitionHash,
        String engineId,
        long seed,
        String completedAt,
        String createdAt
    ) {}

    public record MarbleAudit(
        String auditId,
        String publicCode,
        String schemaVersion,
        String resultStatus,
        String qualificationStatus,
        String mapName,
        String definitionHash,
        String entrySnapshotHash,
        String engineId,
        long seed,
        String startedAt,
        String completedAt,
        String createdAt,
        Map<String, Object> audit
    ) {}

    public MarbleAudit saveMarbleAudit(
        Map<String, Object> rawAudit
    ) throws SQLException {
        Map<String, Object> audit = normalizeMarbleAudit(rawAudit);
        Map<String, Object> qualification = objectMap(
            audit.get("qualification"),
            "qualification"
        );
        Map<String, Object> engine = objectMap(
            audit.get("engine"),
            "engine"
        );
        Map<String, Object> map = objectMap(
            audit.get("map"),
            "map"
        );
        Map<String, Object> run = objectMap(
            audit.get("run"),
            "run"
        );
        Map<String, Object> entries = objectMap(
            audit.get("entries"),
            "entries"
        );

        String auditId = UUID.randomUUID().toString();
        String createdAt = Instant.now().toString();
        String publicCode;

        try (var connection = database.open()) {
            publicCode = createUnusedAuditCode(connection);
            try (var statement = connection.prepareStatement("""
                INSERT INTO viewer_draw_marble_audit(
                  audit_id, public_code, schema_version,
                  result_status, qualification_status,
                  map_name, definition_hash, entry_snapshot_hash,
                  engine_id, seed, started_at, completed_at,
                  audit_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """)) {
                statement.setString(1, auditId);
                statement.setString(
                    2,
                    publicCode
                );
                statement.setString(
                    3,
                    requiredString(
                        audit,
                        "schemaVersion",
                        64
                    )
                );
                statement.setString(
                    4,
                    requiredString(
                        audit,
                        "resultStatus",
                        32
                    )
                );
                statement.setString(
                    5,
                    requiredString(
                        qualification,
                        "status",
                        32
                    )
                );
                statement.setString(
                    6,
                    requiredString(
                        map,
                        "name",
                        80
                    )
                );
                statement.setString(
                    7,
                    requiredHash(
                        map,
                        "definitionHash"
                    )
                );
                statement.setString(
                    8,
                    requiredHash(
                        entries,
                        "snapshotHash"
                    )
                );
                statement.setString(
                    9,
                    requiredString(
                        engine,
                        "id",
                        80
                    )
                );
                statement.setLong(
                    10,
                    longValue(run, "seed", 0)
                );
                statement.setString(
                    11,
                    optionalString(
                        run.get("startedAt"),
                        64
                    )
                );
                statement.setString(
                    12,
                    optionalString(
                        run.get("completedAt"),
                        64
                    )
                );
                statement.setString(
                    13,
                    GSON.toJson(audit)
                );
                statement.setString(14, createdAt);
                statement.executeUpdate();
            }
        }

        return findMarbleAudit(auditId);
    }

    public List<MarbleAuditSummary> recentMarbleAudits(
        int limit
    ) throws SQLException {
        int normalizedLimit = Math.max(1, Math.min(100, limit));
        var result = new ArrayList<MarbleAuditSummary>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT audit_id, public_code, result_status,
                        qualification_status, map_name,
                        definition_hash, engine_id, seed,
                        completed_at, created_at
                 FROM viewer_draw_marble_audit
                 ORDER BY created_at DESC
                 LIMIT ?
                 """)) {
            statement.setInt(1, normalizedLimit);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    result.add(
                        new MarbleAuditSummary(
                            rows.getString("audit_id"),
                            rows.getString("public_code"),
                            rows.getString("result_status"),
                            rows.getString("qualification_status"),
                            rows.getString("map_name"),
                            rows.getString("definition_hash"),
                            rows.getString("engine_id"),
                            rows.getLong("seed"),
                            rows.getString("completed_at"),
                            rows.getString("created_at")
                        )
                    );
                }
            }
        }
        return List.copyOf(result);
    }

    public MarbleAudit findMarbleAudit(String auditId)
        throws SQLException {
        return findMarbleAuditByColumn("audit_id", auditId);
    }

    public MarbleAudit findMarbleAuditByPublicCode(
        String publicCode
    ) throws SQLException {
        String normalized = normalizePublicCode(publicCode);
        if (normalized.length() != 6) {
            throw new NoSuchElementException(
                "viewer draw marble audit not found"
            );
        }
        return findMarbleAuditByColumn(
            "public_code",
            normalized
        );
    }

    private MarbleAudit findMarbleAuditByColumn(
        String column,
        String value
    ) throws SQLException {
        if (
            !"audit_id".equals(column)
            && !"public_code".equals(column)
        ) {
            throw new IllegalArgumentException(
                "unsupported audit lookup"
            );
        }
        try (var connection = database.open();
             var statement = connection.prepareStatement(
                 """
                 SELECT audit_id, public_code, schema_version,
                        result_status, qualification_status,
                        map_name, definition_hash, entry_snapshot_hash,
                        engine_id, seed, started_at, completed_at,
                        created_at, audit_json
                 FROM viewer_draw_marble_audit
                 WHERE %s = ?
                 """.formatted(column)
             )) {
            statement.setString(1, value);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new NoSuchElementException(
                        "viewer draw marble audit not found"
                    );
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> audit = GSON.fromJson(
                    rows.getString("audit_json"),
                    new TypeToken<Map<String, Object>>() {}.getType()
                );
                return new MarbleAudit(
                    rows.getString("audit_id"),
                    rows.getString("public_code"),
                    rows.getString("schema_version"),
                    rows.getString("result_status"),
                    rows.getString("qualification_status"),
                    rows.getString("map_name"),
                    rows.getString("definition_hash"),
                    rows.getString("entry_snapshot_hash"),
                    rows.getString("engine_id"),
                    rows.getLong("seed"),
                    rows.getString("started_at"),
                    rows.getString("completed_at"),
                    rows.getString("created_at"),
                    Map.copyOf(audit)
                );
            }
        }
    }

    public MachineMap saveMachineMap(
        String mapId,
        MachineMapDefinition definition
    ) throws SQLException {
        MachineMapDefinition normalized = normalizeMachineMap(definition);
        String id = mapId == null || mapId.isBlank()
            ? UUID.randomUUID().toString()
            : mapId.trim();
        String now = Instant.now().toString();
        String json = GSON.toJson(normalized);
        String hash = sha256(json);

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                int currentRevision = 0;
                String createdAt = now;
                try (var statement = connection.prepareStatement("""
                    SELECT revision, created_at
                    FROM viewer_draw_machine_map
                    WHERE map_id = ?
                    """)) {
                    statement.setString(1, id);
                    try (var rows = statement.executeQuery()) {
                        if (rows.next()) {
                            currentRevision = rows.getInt("revision");
                            createdAt = rows.getString("created_at");
                        }
                    }
                }

                int nextRevision = currentRevision + 1;

                if (currentRevision == 0) {
                    try (var statement = connection.prepareStatement("""
                        INSERT INTO viewer_draw_machine_map(
                          map_id, name, revision, status, schema_version,
                          definition_json, definition_hash,
                          created_at, updated_at
                        ) VALUES (?, ?, 1, 'DRAFT', ?, ?, ?, ?, ?)
                        """)) {
                        statement.setString(1, id);
                        statement.setString(2, normalized.name());
                        statement.setString(3, normalized.schemaVersion());
                        statement.setString(4, json);
                        statement.setString(5, hash);
                        statement.setString(6, createdAt);
                        statement.setString(7, now);
                        statement.executeUpdate();
                    }
                } else {
                    try (var statement = connection.prepareStatement("""
                        UPDATE viewer_draw_machine_map
                        SET name = ?,
                            revision = revision + 1,
                            schema_version = ?,
                            definition_json = ?,
                            definition_hash = ?,
                            updated_at = ?
                        WHERE map_id = ?
                        """)) {
                        statement.setString(1, normalized.name());
                        statement.setString(2, normalized.schemaVersion());
                        statement.setString(3, json);
                        statement.setString(4, hash);
                        statement.setString(5, now);
                        statement.setString(6, id);
                        if (statement.executeUpdate() != 1) {
                            throw new IllegalStateException(
                                "machine map changed before save"
                            );
                        }
                    }
                }

                try (var statement = connection.prepareStatement("""
                    INSERT INTO viewer_draw_machine_map_revision(
                      map_id, revision, schema_version,
                      definition_json, definition_hash, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """)) {
                    statement.setString(1, id);
                    statement.setInt(2, nextRevision);
                    statement.setString(3, normalized.schemaVersion());
                    statement.setString(4, json);
                    statement.setString(5, hash);
                    statement.setString(6, now);
                    statement.executeUpdate();
                }

                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException("failed to save machine map", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
        return findMachineMap(id);
    }

    public List<MachineMap> recentMachineMaps(int limit)
        throws SQLException {
        int normalizedLimit = Math.max(1, Math.min(100, limit));
        var ids = new ArrayList<String>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT map_id
                 FROM viewer_draw_machine_map
                 WHERE status <> 'ARCHIVED'
                 ORDER BY updated_at DESC
                 LIMIT ?
                 """)) {
            statement.setInt(1, normalizedLimit);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) ids.add(rows.getString(1));
            }
        }

        var result = new ArrayList<MachineMap>();
        for (String id : ids) result.add(findMachineMap(id));
        return List.copyOf(result);
    }

    public MachineMap findMachineMap(String mapId)
        throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT name, revision, status, schema_version,
                        definition_json, definition_hash,
                        created_at, updated_at
                 FROM viewer_draw_machine_map
                 WHERE map_id = ?
                 """)) {
            statement.setString(1, mapId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new NoSuchElementException(
                        "viewer draw machine map not found"
                    );
                }
                String json = rows.getString("definition_json");
                return new MachineMap(
                    mapId,
                    rows.getString("name"),
                    rows.getInt("revision"),
                    rows.getString("status"),
                    rows.getString("schema_version"),
                    rows.getString("definition_hash"),
                    rows.getString("created_at"),
                    rows.getString("updated_at"),
                    GSON.fromJson(json, MachineMapDefinition.class)
                );
            }
        }
    }

    public MachineMapRevision findMachineMapRevision(
        String mapId,
        int revision
    ) throws SQLException {
        if (revision < 1) {
            throw new IllegalArgumentException(
                "revision must be positive"
            );
        }

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT schema_version, definition_json,
                        definition_hash, created_at
                 FROM viewer_draw_machine_map_revision
                 WHERE map_id = ? AND revision = ?
                 """)) {
            statement.setString(1, mapId);
            statement.setInt(2, revision);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new NoSuchElementException(
                        "viewer draw machine map revision not found"
                    );
                }

                return new MachineMapRevision(
                    mapId,
                    revision,
                    rows.getString("schema_version"),
                    rows.getString("definition_hash"),
                    rows.getString("created_at"),
                    GSON.fromJson(
                        rows.getString("definition_json"),
                        MachineMapDefinition.class
                    )
                );
            }
        }
    }

    public void archiveMachineMap(String mapId) throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE viewer_draw_machine_map
                 SET status = 'ARCHIVED', updated_at = ?
                 WHERE map_id = ? AND status <> 'ARCHIVED'
                 """)) {
            statement.setString(1, Instant.now().toString());
            statement.setString(2, mapId);
            if (statement.executeUpdate() != 1) {
                throw new NoSuchElementException(
                    "viewer draw machine map not found"
                );
            }
        }
    }

    public List<String> validateMachineMap(
        MachineMapDefinition definition
    ) {
        try {
            normalizeMachineMap(definition);
            return List.of();
        } catch (IllegalArgumentException error) {
            return List.of(error.getMessage());
        }
    }

    private static MachineMapDefinition normalizeMachineMap(
        MachineMapDefinition raw
    ) {
        if (raw == null) {
            throw new IllegalArgumentException(
                "machine map definition is required"
            );
        }

        String schemaVersion = raw.schemaVersion() == null
            ? ""
            : raw.schemaVersion().trim();
        boolean legacySchema =
            "viewer-draw-machine-map/v0".equals(schemaVersion);
        boolean currentSchema =
            "viewer-draw-machine-map/v1".equals(schemaVersion);
        if (!legacySchema && !currentSchema) {
            throw new IllegalArgumentException(
                "schemaVersion must be viewer-draw-machine-map/v0 or v1"
            );
        }

        String name = raw.name() == null ? "" : raw.name().trim();
        if (name.isBlank() || name.length() > 80) {
            throw new IllegalArgumentException(
                "map name must be 1..80 characters"
            );
        }

        MachineWorld world = raw.world();
        if (world == null) {
            throw new IllegalArgumentException("world is required");
        }
        requireFinite(world.width(), "world.width");
        requireFinite(world.height(), "world.height");
        if (world.width() < 0 || world.height() < 0) {
            throw new IllegalArgumentException(
                "world width/height must be non-negative"
            );
        }
        requireFinite(world.gravityX(), "world.gravityX");
        requireFinite(world.gravityY(), "world.gravityY");

        MachineDrawRule rawRule = raw.drawRule();
        String drawRuleType = rawRule == null || rawRule.type() == null
            ? "RACE_FINISH"
            : rawRule.type().trim().toUpperCase(Locale.ROOT);
        int drawRuleWinnerCount = rawRule == null
            ? 0
            : rawRule.winnerCount();
        if (
            !java.util.Set.of(
                "RACE_FINISH",
                "ORDERED_OUTPUT",
                "SLOT_COLLECTION",
                "LAST_SURVIVOR",
                "CASCADE_SELECTION",
                "RANDOM_OUTPUT_BUCKET",
                "CONDITIONAL_OUTPUT"
            ).contains(drawRuleType)
        ) {
            throw new IllegalArgumentException(
                "unsupported drawRule type: " + drawRuleType
            );
        }

        MachineRunPolicy rawRunPolicy = raw.runPolicy();
        double timeoutSeconds = rawRunPolicy == null
            ? 0
            : rawRunPolicy.timeoutSeconds();
        int qualificationMinWinners = rawRunPolicy == null
            ? 0
            : rawRunPolicy.qualificationMinWinners();
        int qualificationMaxNudges = rawRunPolicy == null
            ? 0
            : rawRunPolicy.qualificationMaxNudges();
        requireFinite(timeoutSeconds, "runPolicy.timeoutSeconds");

        List<MachineComponent> rawComponents =
            raw.components() == null ? List.of() : raw.components();

        var allowedTypes = legacySchema
            ? java.util.Set.of(
                "WALL", "CURVE_WALL", "RAMP", "PEG", "BUMPER",
                "SPAWN", "BURST_SPAWN", "FINISH",
                "GATE", "ROTATOR", "PENDULUM", "SEESAW",
                "FUNNEL", "SPLITTER", "HINGE", "GEAR",
                "PADDLE", "LAUNCHER", "CONVEYOR", "ELEVATOR",
                "OUTPUT", "SLOT", "ELIMINATION"
            )
            : java.util.Set.of(
                "WALL", "CURVE_WALL", "CIRCLE",
                "SPAWN", "BURST_SPAWN", "FINISH",
                "GATE", "ROTATOR", "PENDULUM", "SEESAW",
                "HINGE", "PADDLE",
                "CONVEYOR", "ELEVATOR",
                "OUTPUT", "SLOT", "ELIMINATION"
            );
        var ids = new java.util.LinkedHashSet<String>();
        var componentTypes = new java.util.LinkedHashMap<String, String>();
        var outputKeys = new java.util.LinkedHashSet<String>();
        var outputRanks = new java.util.LinkedHashSet<Integer>();
        var slotKeys = new java.util.LinkedHashSet<String>();
        var eliminationKeys = new java.util.LinkedHashSet<String>();
        var sensorTags = new java.util.LinkedHashSet<String>();
        var branchProducerKeys = new java.util.LinkedHashSet<String>();
        var outputCapacities = new ArrayList<Integer>();
        var normalizedComponents = new ArrayList<MachineComponent>();
        int spawnCount = 0;
        int finishCount = 0;
        int outputCount = 0;
        int slotCount = 0;
        int eliminationCount = 0;
        int totalOutputCapacity = 0;
        int totalSlotCapacity = 0;

        for (MachineComponent rawComponent : rawComponents) {
            if (rawComponent == null) continue;
            String id = rawComponent.id() == null
                ? ""
                : rawComponent.id().trim();
            String type = rawComponent.type() == null
                ? ""
                : rawComponent.type().trim().toUpperCase(Locale.ROOT);

            if (id.isBlank() || !ids.add(id)) {
                throw new IllegalArgumentException(
                    "component ids must be non-empty and unique"
                );
            }
            if (!allowedTypes.contains(type)) {
                throw new IllegalArgumentException(
                    "unsupported component type: " + type
                );
            }
            componentTypes.put(id, type);

            requireFinite(rawComponent.x(), id + ".x");
            requireFinite(rawComponent.y(), id + ".y");
            requireFinite(rawComponent.rotation(), id + ".rotation");
            requireFinite(rawComponent.width(), id + ".width");
            requireFinite(rawComponent.height(), id + ".height");
            requireFinite(rawComponent.radius(), id + ".radius");

            if (
                rawComponent.rotation() < -360
                || rawComponent.rotation() > 360
            ) {
                throw new IllegalArgumentException(
                    id + " rotation must be within -360..360"
                );
            }

            var rectangularTypes = java.util.Set.of(
                "WALL", "CURVE_WALL", "RAMP", "FINISH",
                "GATE", "ROTATOR", "PENDULUM", "SEESAW",
                "FUNNEL", "SPLITTER", "HINGE", "GEAR", "PADDLE",
                "LAUNCHER", "CONVEYOR", "ELEVATOR",
                "OUTPUT", "SLOT", "ELIMINATION"
            );
            if (
                rectangularTypes.contains(type)
                && (
                    rawComponent.width() < 0
                    || rawComponent.height() < 0
                )
            ) {
                throw new IllegalArgumentException(
                    id + " width/height must be non-negative"
                );
            }

            var circularTypes = java.util.Set.of(
                "CIRCLE", "PEG", "BUMPER", "SPAWN", "BURST_SPAWN"
            );
            if (
                circularTypes.contains(type)
                && rawComponent.radius() < 0
            ) {
                throw new IllegalArgumentException(
                    id + " radius must be non-negative"
                );
            }

            Map<String, Object> properties =
                rawComponent.properties() == null
                    ? Map.of()
                    : rawComponent.properties();

            var colliderTypes = java.util.Set.of(
                "WALL", "CURVE_WALL", "RAMP", "PEG", "BUMPER",
                "CIRCLE", "GATE", "ROTATOR", "PENDULUM", "SEESAW",
                "FUNNEL", "SPLITTER", "HINGE", "GEAR", "PADDLE",
                "LAUNCHER", "CONVEYOR", "ELEVATOR"
            );
            if (colliderTypes.contains(type)) {
                double restitution = numberProperty(
                    properties, "restitution", 0.35
                );
                double friction = numberProperty(
                    properties, "friction", 0.05
                );
                double boost = numberProperty(
                    properties, "boost", 0
                );
                if (restitution < 0 || friction < 0 || boost < 0) {
                    throw new IllegalArgumentException(
                        id + " restitution/friction/boost must be non-negative"
                    );
                }
            }

            String[] signedAngleKeys = {
                "lowerAngle",
                "upperAngle",
                "burstDirectionDegrees",
                "axisAngle"
            };
            for (String key : signedAngleKeys) {
                if (!properties.containsKey(key)) continue;
                double value = numberProperty(properties, key, 0);
                if (value < -360 || value > 360) {
                    throw new IllegalArgumentException(
                        id + " " + key + " must be within -360..360"
                    );
                }
            }

            String[] angleMagnitudeKeys = {
                "amplitude",
                "openAngle",
                "burstSpreadDegrees"
            };
            for (String key : angleMagnitudeKeys) {
                if (!properties.containsKey(key)) continue;
                double value = numberProperty(properties, key, 0);
                if (value < 0 || value > 360) {
                    throw new IllegalArgumentException(
                        id + " " + key + " must be within 0..360"
                    );
                }
            }

            String[] nonNegativeKeys = {
                "thickness",
                "marbleRadius",
                "period",
                "jointFriction",
                "motorTorque",
                "burstPower",
                "burstPowerVariance",
                "burstIntervalMs",
                "beltGrip",
                "motorForce"
            };
            for (String key : nonNegativeKeys) {
                if (!properties.containsKey(key)) continue;
                double value = numberProperty(properties, key, 0);
                if (value < 0) {
                    throw new IllegalArgumentException(
                        id + " " + key + " must be non-negative"
                    );
                }
            }

            if (
                legacySchema
                && "LAUNCHER".equals(type)
                && properties.containsKey("launchDirectionDegrees")
            ) {
                double direction = numberProperty(
                    properties,
                    "launchDirectionDegrees",
                    -90
                );
                if (direction < -360 || direction > 360) {
                    throw new IllegalArgumentException(
                        id + " launchDirectionDegrees must be within -360..360"
                    );
                }
            }

            if ("ROTATOR".equals(type)) {
                double rawBladeCount = numberProperty(
                    properties,
                    "bladeCount",
                    1
                );
                int bladeCount = (int) rawBladeCount;
                if (
                    rawBladeCount != bladeCount
                    || bladeCount < 1
                    || bladeCount > 4
                ) {
                    throw new IllegalArgumentException(
                        id + " bladeCount must be an integer within 1..4"
                    );
                }
            }

            if (
                java.util.Set.of(
                    "FINISH", "OUTPUT", "SLOT", "ELIMINATION"
                ).contains(type)
            ) {
                String sensorTag = stringProperty(
                    properties,
                    "sensorTag",
                    ""
                ).trim();
                if (!sensorTag.isBlank()) {
                    sensorTags.add(sensorTag);
                }
            }

            if (legacySchema && "LAUNCHER".equals(type)) {
                double launchPower = numberProperty(
                    properties,
                    "launchPower",
                    1.2
                );
                if (launchPower < 0) {
                    throw new IllegalArgumentException(
                        id + " launchPower must be non-negative"
                    );
                }
            }

            if ("GEAR".equals(type)) {
                String linkedComponentId = stringProperty(
                    properties,
                    "linkedComponentId",
                    ""
                ).trim();
                double ratio = numberProperty(
                    properties,
                    "gearRatio",
                    -1
                );
                if (id.equals(linkedComponentId)) {
                    throw new IllegalArgumentException(
                        id + " cannot link to itself"
                    );
                }
            }
            if ("ELEVATOR".equals(type)) {
                double axisAngle = numberProperty(
                    properties,
                    "axisAngle",
                    -90
                );
                double travelMin = numberProperty(
                    properties,
                    "travelMin",
                    -120
                );
                double travelMax = numberProperty(
                    properties,
                    "travelMax",
                    120
                );
                double motorSpeed = numberProperty(
                    properties,
                    "motorSpeed",
                    90
                );
                double motorForce = numberProperty(
                    properties,
                    "motorForce",
                    45
                );
                double startDirection = numberProperty(
                    properties,
                    "startDirection",
                    1
                );
            }
            if ("OUTPUT".equals(type)) {
                String outputKey = stringProperty(
                    properties,
                    "outputKey",
                    ""
                ).trim();
                int outputRank = (int) numberProperty(
                    properties,
                    "outputRank",
                    0
                );
                int outputCapacity = (int) numberProperty(
                    properties,
                    "outputCapacity",
                    1
                );
                double outputWeight = numberProperty(
                    properties,
                    "outputWeight",
                    1
                );
                int outputPriority = (int) numberProperty(
                    properties,
                    "outputPriority",
                    0
                );
                String conditionType = stringProperty(
                    properties,
                    "conditionType",
                    "ALWAYS"
                ).trim().toUpperCase(Locale.ROOT);
                int conditionClaims = (int) numberProperty(
                    properties,
                    "conditionClaims",
                    1
                );
                double conditionSeconds = numberProperty(
                    properties,
                    "conditionSeconds",
                    1
                );
                String branchSetKey = stringProperty(
                    properties,
                    "branchSetKey",
                    ""
                ).trim();
                String branchSetValue = stringProperty(
                    properties,
                    "branchSetValue",
                    "ON"
                ).trim();
                if (outputKey.isBlank()) {
                    throw new IllegalArgumentException(
                        id + " outputKey is required"
                    );
                }
                if (!outputKeys.add(outputKey)) {
                    throw new IllegalArgumentException(
                        "outputKey must be unique"
                    );
                }
                if (
                    "ORDERED_OUTPUT".equals(drawRuleType)
                    && !outputRanks.add(outputRank)
                ) {
                    throw new IllegalArgumentException(
                        "ORDERED_OUTPUT outputRank must be unique"
                    );
                }
                outputRanks.add(outputRank);
                if (
                    !java.util.Set.of(
                        "ALWAYS",
                        "AFTER_ANY_CLAIM",
                        "AFTER_OUTPUT_CLAIMS",
                        "AFTER_OUTPUT_FULL",
                        "AFTER_SECONDS",
                        "AFTER_SENSOR_CLAIMS",
                        "AFTER_BRANCH_STATE"
                    ).contains(conditionType)
                ) {
                    throw new IllegalArgumentException(
                        id + " conditionType is invalid"
                    );
                }
                if (!branchSetKey.isBlank()) {
                    branchProducerKeys.add(
                        branchSetKey + "\u0000" + branchSetValue
                    );
                }
                outputCapacities.add(outputCapacity);
                totalOutputCapacity += outputCapacity;
                outputCount += 1;
            }
            if ("SLOT".equals(type)) {
                String slotKey = stringProperty(
                    properties,
                    "slotKey",
                    ""
                ).trim();
                int slotCapacity = (int) numberProperty(
                    properties,
                    "slotCapacity",
                    1
                );
                if (slotKey.isBlank()) {
                    throw new IllegalArgumentException(
                        id + " slotKey is required"
                    );
                }
                if (!slotKeys.add(slotKey)) {
                    throw new IllegalArgumentException(
                        "slotKey must be unique"
                    );
                }
                totalSlotCapacity += slotCapacity;
                slotCount += 1;
            }
            if ("ELIMINATION".equals(type)) {
                String eliminationKey = stringProperty(
                    properties,
                    "eliminationKey",
                    ""
                ).trim();
                if (eliminationKey.isBlank()) {
                    throw new IllegalArgumentException(
                        id + " eliminationKey is required"
                    );
                }
                if (!eliminationKeys.add(eliminationKey)) {
                    throw new IllegalArgumentException(
                        "eliminationKey must be unique"
                    );
                }
                eliminationCount += 1;
            }

            String soundMaterial = stringProperty(
                properties,
                "soundMaterial",
                "metal"
            ).trim().toLowerCase(Locale.ROOT);
            String instrument = stringProperty(
                properties,
                "instrument",
                "none"
            ).trim().toLowerCase(Locale.ROOT);
            double audioNote = numberProperty(
                properties,
                "audioNote",
                60
            );
            double audioGain = numberProperty(
                properties,
                "audioGain",
                1
            );
            double audioPan = numberProperty(
                properties,
                "audioPan",
                0
            );
            if (
                !java.util.Set.of(
                    "metal", "wood", "glass",
                    "rubber", "plastic", "stone"
                ).contains(soundMaterial)
            ) {
                throw new IllegalArgumentException(
                    id + " soundMaterial is invalid"
                );
            }
            if (
                !java.util.Set.of(
                    "none", "bell", "chime",
                    "xylophone", "drum", "click"
                ).contains(instrument)
            ) {
                throw new IllegalArgumentException(
                    id + " instrument is invalid"
                );
            }
            if (audioNote < 24 || audioNote > 108) {
                throw new IllegalArgumentException(
                    id + " audioNote must be within 24..108"
                );
            }
            if (audioGain < 0 || audioGain > 2) {
                throw new IllegalArgumentException(
                    id + " audioGain must be within 0..2"
                );
            }
            if (audioPan < -1 || audioPan > 1) {
                throw new IllegalArgumentException(
                    id + " audioPan must be within -1..1"
                );
            }

            if ("SPAWN".equals(type)) spawnCount += 1;
            if ("FINISH".equals(type)) finishCount += 1;

            normalizedComponents.add(
                new MachineComponent(
                    id,
                    type,
                    rawComponent.x(),
                    rawComponent.y(),
                    rawComponent.rotation(),
                    rawComponent.width(),
                    rawComponent.height(),
                    rawComponent.radius(),
                    rawComponent.properties() == null
                        ? Map.of()
                        : Map.copyOf(rawComponent.properties())
                )
            );
        }

        for (MachineComponent component : normalizedComponents) {
            if (!legacySchema || !"GEAR".equals(component.type())) continue;
            String linkedComponentId = stringProperty(
                component.properties(),
                "linkedComponentId",
                ""
            ).trim();
            if (linkedComponentId.isBlank()) continue;

            String targetType = componentTypes.get(linkedComponentId);
            if (targetType == null) {
                throw new IllegalArgumentException(
                    component.id() + " linkedComponentId target does not exist"
                );
            }
            if (
                !java.util.Set.of(
                    "GEAR", "HINGE", "PADDLE", "ELEVATOR"
                ).contains(targetType)
            ) {
                throw new IllegalArgumentException(
                    component.id() + " gear link requires a joint component"
                );
            }
        }

        var outputsByKey =
            new java.util.LinkedHashMap<String, MachineComponent>();
        for (MachineComponent component : normalizedComponents) {
            if (!"OUTPUT".equals(component.type())) continue;
            String key = stringProperty(
                component.properties(),
                "outputKey",
                ""
            ).trim();
            outputsByKey.put(key, component);
        }

        for (MachineComponent component : outputsByKey.values()) {
            String mode = stringProperty(
                component.properties(),
                "conditionType",
                "ALWAYS"
            ).trim().toUpperCase(Locale.ROOT);

            if (
                "AFTER_OUTPUT_CLAIMS".equals(mode)
                || "AFTER_OUTPUT_FULL".equals(mode)
            ) {
                String targetKey = stringProperty(
                    component.properties(),
                    "conditionOutputKey",
                    ""
                ).trim();
                String ownKey = stringProperty(
                    component.properties(),
                    "outputKey",
                    ""
                ).trim();
                if (
                    targetKey.isBlank()
                    || !outputsByKey.containsKey(targetKey)
                ) {
                    throw new IllegalArgumentException(
                        component.id()
                            + " conditional output target does not exist"
                    );
                }
                if (ownKey.equals(targetKey)) {
                    throw new IllegalArgumentException(
                        component.id()
                            + " conditional output cannot reference itself"
                    );
                }
                if ("AFTER_OUTPUT_CLAIMS".equals(mode)) {
                    int threshold = (int) numberProperty(
                        component.properties(),
                        "conditionClaims",
                        1
                    );
                    int capacity = (int) numberProperty(
                        outputsByKey.get(targetKey).properties(),
                        "outputCapacity",
                        1
                    );
                    if (threshold > capacity) {
                        throw new IllegalArgumentException(
                            component.id()
                                + " conditionClaims exceeds target capacity"
                        );
                    }
                }
            }

            if ("AFTER_SENSOR_CLAIMS".equals(mode)) {
                String tag = stringProperty(
                    component.properties(),
                    "conditionSensorTag",
                    ""
                ).trim();
                if (tag.isBlank() || !sensorTags.contains(tag)) {
                    throw new IllegalArgumentException(
                        component.id()
                            + " conditional sensor tag does not exist"
                    );
                }
            }

            if ("AFTER_BRANCH_STATE".equals(mode)) {
                String key = stringProperty(
                    component.properties(),
                    "conditionBranchKey",
                    ""
                ).trim();
                String value = stringProperty(
                    component.properties(),
                    "conditionBranchValue",
                    "ON"
                ).trim();
                if (
                    key.isBlank()
                    || !branchProducerKeys.contains(
                        key + "\u0000" + value
                    )
                ) {
                    throw new IllegalArgumentException(
                        component.id()
                            + " branch state producer does not exist"
                    );
                }
            }
        }

        if ("CONDITIONAL_OUTPUT".equals(drawRuleType)) {
            if (outputCount < 1) {
                throw new IllegalArgumentException(
                    "CONDITIONAL_OUTPUT requires at least one OUTPUT"
                );
            }
            boolean hasStarter = false;
            for (MachineComponent component : outputsByKey.values()) {
                String mode = stringProperty(
                    component.properties(),
                    "conditionType",
                    "ALWAYS"
                ).trim().toUpperCase(Locale.ROOT);
                if (
                    "ALWAYS".equals(mode)
                    || "AFTER_SECONDS".equals(mode)
                ) {
                    hasStarter = true;
                    break;
                }
                if ("AFTER_SENSOR_CLAIMS".equals(mode)) {
                    String tag = stringProperty(
                        component.properties(),
                        "conditionSensorTag",
                        ""
                    ).trim();
                    boolean externalSensor = normalizedComponents.stream()
                        .anyMatch(sensor ->
                            !"OUTPUT".equals(sensor.type())
                            && java.util.Set.of(
                                "FINISH", "SLOT", "ELIMINATION"
                            ).contains(sensor.type())
                            && tag.equals(
                                stringProperty(
                                    sensor.properties(),
                                    "sensorTag",
                                    ""
                                ).trim()
                            )
                        );
                    if (externalSensor) {
                        hasStarter = true;
                        break;
                    }
                }
            }
            if (!hasStarter) {
                throw new IllegalArgumentException(
                    "CONDITIONAL_OUTPUT requires an independently activatable root condition"
                );
            }
            var visiting = new java.util.LinkedHashSet<String>();
            var visited = new java.util.LinkedHashSet<String>();
            for (String key : outputsByKey.keySet()) {
                if (
                    hasConditionalOutputCycle(
                        key,
                        outputsByKey,
                        normalizedComponents,
                        visiting,
                        visited
                    )
                ) {
                    throw new IllegalArgumentException(
                        "conditional output dependency contains a cycle"
                    );
                }
            }
        }

        if (spawnCount < 1) {
            throw new IllegalArgumentException(
                "machine map requires at least one SPAWN"
            );
        }
        if ("RACE_FINISH".equals(drawRuleType) && finishCount < 1) {
            throw new IllegalArgumentException(
                "RACE_FINISH requires at least one FINISH"
            );
        }
        if ("ORDERED_OUTPUT".equals(drawRuleType)) {
            int winners = drawRuleWinnerCount == 0
                ? outputCount
                : drawRuleWinnerCount;
            if (outputCount < 1) {
                throw new IllegalArgumentException(
                    "ORDERED_OUTPUT requires at least one OUTPUT"
                );
            }
            if (winners < 1 || winners > outputCount) {
                throw new IllegalArgumentException(
                    "ORDERED_OUTPUT winnerCount exceeds OUTPUT count"
                );
            }
            for (int rank = 1; rank <= winners; rank += 1) {
                if (!outputRanks.contains(rank)) {
                    throw new IllegalArgumentException(
                        "ORDERED_OUTPUT requires contiguous outputRank values"
                    );
                }
            }
        }
        if ("SLOT_COLLECTION".equals(drawRuleType)) {
            int winners = drawRuleWinnerCount == 0
                ? totalSlotCapacity
                : drawRuleWinnerCount;
            if (slotCount < 1) {
                throw new IllegalArgumentException(
                    "SLOT_COLLECTION requires at least one SLOT"
                );
            }
            if (winners < 1 || winners > totalSlotCapacity) {
                throw new IllegalArgumentException(
                    "SLOT_COLLECTION winnerCount exceeds total slot capacity"
                );
            }
        }
        if ("LAST_SURVIVOR".equals(drawRuleType)) {
            int winners = drawRuleWinnerCount == 0
                ? 1
                : drawRuleWinnerCount;
            if (eliminationCount < 1) {
                throw new IllegalArgumentException(
                    "LAST_SURVIVOR requires at least one ELIMINATION"
                );
            }
            if (winners < 1 || winners > 64) {
                throw new IllegalArgumentException(
                    "LAST_SURVIVOR winnerCount must be within 1..64"
                );
            }
        }
        if ("CASCADE_SELECTION".equals(drawRuleType)) {
            int winners = drawRuleWinnerCount == 0
                ? totalOutputCapacity
                : drawRuleWinnerCount;
            if (outputCount < 1) {
                throw new IllegalArgumentException(
                    "CASCADE_SELECTION requires at least one OUTPUT"
                );
            }
            if (winners < 1 || winners > totalOutputCapacity) {
                throw new IllegalArgumentException(
                    "CASCADE_SELECTION winnerCount exceeds total output capacity"
                );
            }
        }
        if ("CONDITIONAL_OUTPUT".equals(drawRuleType)) {
            int winners = drawRuleWinnerCount == 0
                ? totalOutputCapacity
                : drawRuleWinnerCount;
            if (winners < 1 || winners > totalOutputCapacity) {
                throw new IllegalArgumentException(
                    "CONDITIONAL_OUTPUT winnerCount exceeds total output capacity"
                );
            }
        }
        if ("RANDOM_OUTPUT_BUCKET".equals(drawRuleType)) {
            int winners = drawRuleWinnerCount == 0
                ? 1
                : drawRuleWinnerCount;
            if (outputCount < 1) {
                throw new IllegalArgumentException(
                    "RANDOM_OUTPUT_BUCKET requires at least one OUTPUT"
                );
            }
            if (winners < 1 || winners > 64) {
                throw new IllegalArgumentException(
                    "RANDOM_OUTPUT_BUCKET winnerCount must be within 1..64"
                );
            }
            for (int capacity : outputCapacities) {
                if (capacity < winners) {
                    throw new IllegalArgumentException(
                        "every random output bucket must fit winnerCount"
                    );
                }
            }
        }

        return new MachineMapDefinition(
            schemaVersion,
            name,
            new MachineWorld(
                world.width(),
                world.height(),
                world.gravityX(),
                world.gravityY()
            ),
            new MachineDrawRule(
                drawRuleType,
                drawRuleWinnerCount
            ),
            new MachineRunPolicy(
                timeoutSeconds,
                qualificationMinWinners,
                qualificationMaxNudges
            ),
            List.copyOf(normalizedComponents)
        );
    }

    private static boolean hasConditionalOutputCycle(
        String key,
        Map<String, MachineComponent> outputsByKey,
        List<MachineComponent> components,
        java.util.Set<String> visiting,
        java.util.Set<String> visited
    ) {
        if (visiting.contains(key)) return true;
        if (visited.contains(key)) return false;

        visiting.add(key);
        MachineComponent component = outputsByKey.get(key);
        if (component != null) {
            for (
                String next : conditionalOutputDependencies(
                    component,
                    outputsByKey,
                    components
                )
            ) {
                if (
                    outputsByKey.containsKey(next)
                    && hasConditionalOutputCycle(
                        next,
                        outputsByKey,
                        components,
                        visiting,
                        visited
                    )
                ) {
                    return true;
                }
            }
        }
        visiting.remove(key);
        visited.add(key);
        return false;
    }

    private static List<String> conditionalOutputDependencies(
        MachineComponent component,
        Map<String, MachineComponent> outputsByKey,
        List<MachineComponent> components
    ) {
        String mode = stringProperty(
            component.properties(),
            "conditionType",
            "ALWAYS"
        ).trim().toUpperCase(Locale.ROOT);
        var result = new ArrayList<String>();

        if (
            "AFTER_OUTPUT_CLAIMS".equals(mode)
            || "AFTER_OUTPUT_FULL".equals(mode)
        ) {
            String key = stringProperty(
                component.properties(),
                "conditionOutputKey",
                ""
            ).trim();
            if (!key.isBlank()) result.add(key);
            return List.copyOf(result);
        }

        if ("AFTER_SENSOR_CLAIMS".equals(mode)) {
            String tag = stringProperty(
                component.properties(),
                "conditionSensorTag",
                ""
            ).trim();
            boolean external = components.stream().anyMatch(
                sensor ->
                    !"OUTPUT".equals(sensor.type())
                    && java.util.Set.of(
                        "FINISH", "SLOT", "ELIMINATION"
                    ).contains(sensor.type())
                    && tag.equals(
                        stringProperty(
                            sensor.properties(),
                            "sensorTag",
                            ""
                        ).trim()
                    )
            );
            if (external) return List.of();

            for (MachineComponent candidate : outputsByKey.values()) {
                if (
                    tag.equals(
                        stringProperty(
                            candidate.properties(),
                            "sensorTag",
                            ""
                        ).trim()
                    )
                ) {
                    result.add(
                        stringProperty(
                            candidate.properties(),
                            "outputKey",
                            ""
                        ).trim()
                    );
                }
            }
            return result.size() == 1
                ? List.copyOf(result)
                : List.of();
        }

        if ("AFTER_BRANCH_STATE".equals(mode)) {
            String branchKey = stringProperty(
                component.properties(),
                "conditionBranchKey",
                ""
            ).trim();
            String branchValue = stringProperty(
                component.properties(),
                "conditionBranchValue",
                "ON"
            ).trim();
            for (MachineComponent candidate : outputsByKey.values()) {
                if (
                    branchKey.equals(
                        stringProperty(
                            candidate.properties(),
                            "branchSetKey",
                            ""
                        ).trim()
                    )
                    && branchValue.equals(
                        stringProperty(
                            candidate.properties(),
                            "branchSetValue",
                            "ON"
                        ).trim()
                    )
                ) {
                    result.add(
                        stringProperty(
                            candidate.properties(),
                            "outputKey",
                            ""
                        ).trim()
                    );
                }
            }
            return result.size() == 1
                ? List.copyOf(result)
                : List.of();
        }

        return List.copyOf(result);
    }

    private Map<String, Object> normalizeMarbleAudit(
        Map<String, Object> rawAudit
    ) {
        if (rawAudit == null) {
            throw new IllegalArgumentException(
                "marble audit is required"
            );
        }

        String json = GSON.toJson(rawAudit);
        if (json.length() > 2_000_000) {
            throw new IllegalArgumentException(
                "marble audit is too large"
            );
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> audit = GSON.fromJson(
            json,
            new TypeToken<Map<String, Object>>() {}.getType()
        );

        String schemaVersion = requiredString(
            audit,
            "schemaVersion",
            64
        );
        if (!"viewer-draw-run-audit/v0".equals(schemaVersion)) {
            throw new IllegalArgumentException(
                "unsupported marble audit schemaVersion"
            );
        }

        String resultStatus = requiredString(
            audit,
            "resultStatus",
            32
        ).toUpperCase(Locale.ROOT);
        if (
            !"COMPLETED".equals(resultStatus)
            && !"TIMEOUT".equals(resultStatus)
        ) {
            throw new IllegalArgumentException(
                "invalid marble audit resultStatus"
            );
        }

        Map<String, Object> qualification = objectMap(
            audit.get("qualification"),
            "qualification"
        );
        String qualificationStatus = requiredString(
            qualification,
            "status",
            32
        ).toUpperCase(Locale.ROOT);
        if (
            !"QUALIFIED".equals(qualificationStatus)
            && !"NOT_QUALIFIED".equals(qualificationStatus)
        ) {
            throw new IllegalArgumentException(
                "invalid marble audit qualification status"
            );
        }

        Map<String, Object> map = objectMap(
            audit.get("map"),
            "map"
        );
        requiredString(map, "name", 80);
        requiredHash(map, "definitionHash");

        Map<String, Object> entries = objectMap(
            audit.get("entries"),
            "entries"
        );
        requiredHash(entries, "snapshotHash");

        Map<String, Object> engine = objectMap(
            audit.get("engine"),
            "engine"
        );
        requiredString(engine, "id", 80);

        Map<String, Object> run = objectMap(
            audit.get("run"),
            "run"
        );
        longValue(run, "seed", 0);
        optionalString(run.get("startedAt"), 64);
        optionalString(run.get("completedAt"), 64);

        objectMap(audit.get("result"), "result");
        return Map.copyOf(audit);
    }

    private String createUnusedAuditCode(
        java.sql.Connection connection
    ) throws SQLException {
        for (int attempt = 0; attempt < 32; attempt += 1) {
            String code = createPublicCode();
            try (var statement = connection.prepareStatement("""
                SELECT 1
                FROM viewer_draw_marble_audit
                WHERE public_code = ?
                """)) {
                statement.setString(1, code);
                try (var rows = statement.executeQuery()) {
                    if (!rows.next()) return code;
                }
            }
        }
        throw new SQLException(
            "failed to allocate marble audit public code"
        );
    }

    private static Map<String, Object> objectMap(
        Object value,
        String name
    ) {
        if (!(value instanceof Map<?, ?> raw)) {
            throw new IllegalArgumentException(
                name + " must be an object"
            );
        }
        var result = new LinkedHashMap<String, Object>();
        for (var entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw new IllegalArgumentException(
                    name + " contains a non-string key"
                );
            }
            result.put(key, entry.getValue());
        }
        return result;
    }

    private static String requiredString(
        Map<String, Object> source,
        String key,
        int maxLength
    ) {
        String value = optionalString(
            source.get(key),
            maxLength
        );
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(
                key + " is required"
            );
        }
        return value;
    }

    private static String requiredHash(
        Map<String, Object> source,
        String key
    ) {
        String value = requiredString(source, key, 64);
        if (!value.matches("[0-9a-fA-F]{64}")) {
            throw new IllegalArgumentException(
                key + " must be a SHA-256 hex value"
            );
        }
        return value.toLowerCase(Locale.ROOT);
    }

    private static String optionalString(
        Object value,
        int maxLength
    ) {
        if (value == null) return null;
        String text = String.valueOf(value).trim();
        if (text.length() > maxLength) {
            throw new IllegalArgumentException(
                "string value is too long"
            );
        }
        return text;
    }

    private static long longValue(
        Map<String, Object> source,
        String key,
        long fallback
    ) {
        Object value = source.get(key);
        if (value == null) return fallback;
        if (value instanceof Number number) {
            return number.longValue();
        }
        try {
            return Long.parseLong(String.valueOf(value).trim());
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(
                key + " must be an integer"
            );
        }
    }

    private static String stringProperty(
        Map<String, Object> properties,
        String key,
        String fallback
    ) {
        Object value = properties.get(key);
        return value == null ? fallback : String.valueOf(value);
    }

    private static double numberProperty(
        Map<String, Object> properties,
        String key,
        double fallback
    ) {
        Object value = properties.get(key);
        if (value == null) return fallback;
        if (value instanceof Number number) {
            double result = number.doubleValue();
            requireFinite(result, key);
            return result;
        }
        if (value instanceof String text) {
            try {
                double result = Double.parseDouble(text.trim());
                requireFinite(result, key);
                return result;
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException(
                    key + " must be numeric"
                );
            }
        }
        throw new IllegalArgumentException(key + " must be numeric");
    }

    private static void requireFinite(double value, String name) {
        if (!Double.isFinite(value)) {
            throw new IllegalArgumentException(name + " must be finite");
        }
    }

    private static String sha256(String value) {
        try {
            return java.util.HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(
                    value.getBytes(StandardCharsets.UTF_8)
                )
            );
        } catch (Exception error) {
            throw new IllegalStateException("failed to hash machine map", error);
        }
    }

    public Session create(
        String name,
        String mode,
        List<String> manualEntries,
        Map<String, Object> config
    ) throws SQLException {
        String normalizedMode = normalizeMode(mode);
        String sessionId = UUID.randomUUID().toString();
        String publicCode = createPublicCode();
        String now = Instant.now().toString();
        String normalizedName = name == null || name.isBlank()
            ? defaultName(normalizedMode)
            : name.trim();
        Map<String, Object> normalizedConfig = normalizeConfig(
            normalizedMode,
            config == null ? Map.of() : config
        );
        List<String> entries = normalizedMode.equals("RANDOM")
            ? normalizeManualEntries(manualEntries)
            : List.of();

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO viewer_draw_session(
                        session_id, public_code, name, mode, entry_source, state,
                        config_json, entry_count, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'MANUAL_LIST', 'DRAFT', ?, ?, ?, ?)
                    """)) {
                    statement.setString(1, sessionId);
                    statement.setString(2, publicCode);
                    statement.setString(3, normalizedName);
                    statement.setString(4, normalizedMode);
                    statement.setString(5, GSON.toJson(normalizedConfig));
                    statement.setInt(6, entries.size());
                    statement.setString(7, now);
                    statement.setString(8, now);
                    statement.executeUpdate();
                }

                int index = 0;
                for (String displayName : entries) {
                    try (var statement = connection.prepareStatement("""
                        INSERT INTO viewer_draw_entry(
                            session_id, entry_index, entry_id,
                            display_name, label
                        ) VALUES (?, ?, ?, ?, ?)
                        """)) {
                        statement.setString(1, sessionId);
                        statement.setInt(2, index++);
                        statement.setString(3, UUID.randomUUID().toString());
                        statement.setString(4, displayName);
                        statement.setString(5, displayName);
                        statement.executeUpdate();
                    }
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException("failed to create viewer draw session", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
        return find(sessionId);
    }

    public List<Session> recent(int limit) throws SQLException {
        int normalizedLimit = Math.max(1, Math.min(100, limit));
        var ids = new ArrayList<String>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT session_id
                 FROM viewer_draw_session
                 ORDER BY updated_at DESC
                 LIMIT ?
                 """)) {
            statement.setInt(1, normalizedLimit);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) ids.add(rows.getString(1));
            }
        }
        var result = new ArrayList<Session>();
        for (String id : ids) result.add(find(id));
        return List.copyOf(result);
    }

    public Session find(String sessionId) throws SQLException {
        Map<String, Object> config;
        String publicCode;
        String name;
        String mode;
        String entrySource;
        String state;
        String hash;
        int entryCount;
        String createdAt;
        String updatedAt;
        String completedAt;

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT public_code, name, mode, entry_source, state, config_json,
                        frozen_entry_hash, entry_count, created_at,
                        updated_at, completed_at
                 FROM viewer_draw_session
                 WHERE session_id = ?
                 """)) {
            statement.setString(1, sessionId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) throw new NoSuchElementException("viewer draw session not found");
                publicCode = rows.getString("public_code");
                name = rows.getString("name");
                mode = rows.getString("mode");
                entrySource = rows.getString("entry_source");
                state = rows.getString("state");
                config = GSON.fromJson(
                    rows.getString("config_json"),
                    new TypeToken<LinkedHashMap<String, Object>>() {}.getType()
                );
                hash = rows.getString("frozen_entry_hash");
                entryCount = rows.getInt("entry_count");
                createdAt = rows.getString("created_at");
                updatedAt = rows.getString("updated_at");
                completedAt = rows.getString("completed_at");
            }
        }

        var entries = new ArrayList<DrawEntry>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT entry_id, provider_id, user_id, display_name, label
                 FROM viewer_draw_entry
                 WHERE session_id = ?
                 ORDER BY entry_index
                 """)) {
            statement.setString(1, sessionId);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    entries.add(new DrawEntry(
                        rows.getString("entry_id"),
                        rows.getString("provider_id"),
                        rows.getString("user_id"),
                        rows.getString("display_name"),
                        rows.getString("label")
                    ));
                }
            }
        }

        Object drawResult = null;
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT result_json FROM viewer_draw_result WHERE session_id = ?
                 """)) {
            statement.setString(1, sessionId);
            try (var rows = statement.executeQuery()) {
                if (rows.next()) {
                    drawResult = GSON.fromJson(rows.getString(1), Object.class);
                }
            }
        }

        return new Session(
            sessionId, publicCode, name, mode, entrySource, state, config, hash,
            entryCount, createdAt, updatedAt, completedAt,
            List.copyOf(entries), drawResult
        );
    }

    public Session findByPublicCode(String publicCode) throws SQLException {
        String normalized = normalizePublicCode(publicCode);
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT session_id
                 FROM viewer_draw_session
                 WHERE public_code = ?
                 """)) {
            statement.setString(1, normalized);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new NoSuchElementException("viewer draw session not found");
                }
                return find(rows.getString(1));
            }
        }
    }

    public Session freeze(String sessionId) throws SQLException {
        Session session = find(sessionId);
        if (!"DRAFT".equals(session.state())) {
            if ("FROZEN".equals(session.state())) return session;
            throw new IllegalStateException("only DRAFT sessions can be frozen");
        }

        validateBeforeFreeze(session);
        String hash = frozenHash(session);
        String now = Instant.now().toString();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE viewer_draw_session
                 SET state = 'FROZEN', frozen_entry_hash = ?, updated_at = ?
                 WHERE session_id = ? AND state = 'DRAFT'
                 """)) {
            statement.setString(1, hash);
            statement.setString(2, now);
            statement.setString(3, sessionId);
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException("session state changed before freeze");
            }
        }
        return find(sessionId);
    }

    public Session start(String sessionId) throws SQLException {
        Session session = find(sessionId);
        if (!"FROZEN".equals(session.state())) {
            throw new IllegalStateException("session must be FROZEN before draw");
        }

        Object result = switch (session.mode()) {
            case "RANDOM" -> runRandomDraw(session);
            case "NUMBER" -> runNumberDraw(session);
            default -> throw new IllegalStateException("unsupported draw mode: " + session.mode());
        };

        String now = Instant.now().toString();
        var audit = new LinkedHashMap<String, Object>();
        audit.put("sessionId", sessionId);
        audit.put("mode", session.mode());
        audit.put("entrySource", session.entrySource());
        audit.put("frozenEntryHash", session.frozenEntryHash());
        audit.put("entryCount", session.entryCount());
        audit.put("rngAlgorithm", RNG_ALGORITHM);
        audit.put("completedAt", now);

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO viewer_draw_result(
                        session_id, result_json, rng_algorithm, audit_json, created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """)) {
                    statement.setString(1, sessionId);
                    statement.setString(2, GSON.toJson(result));
                    statement.setString(3, RNG_ALGORITHM);
                    statement.setString(4, GSON.toJson(audit));
                    statement.setString(5, now);
                    statement.executeUpdate();
                }
                try (var statement = connection.prepareStatement("""
                    UPDATE viewer_draw_session
                    SET state = 'COMPLETED', completed_at = ?, updated_at = ?
                    WHERE session_id = ? AND state = 'FROZEN'
                    """)) {
                    statement.setString(1, now);
                    statement.setString(2, now);
                    statement.setString(3, sessionId);
                    if (statement.executeUpdate() != 1) {
                        throw new IllegalStateException("session state changed before draw completion");
                    }
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException("viewer draw failed", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
        return find(sessionId);
    }

    private static Map<String, Object> runRandomDraw(Session session) {
        int winnerCount = intConfig(session.config(), "winnerCount", 1);
        var pool = new ArrayList<>(session.entries());
        secureShuffle(pool);
        var winners = pool.subList(0, winnerCount);

        var result = new LinkedHashMap<String, Object>();
        result.put("mode", "RANDOM");
        result.put("winnerCount", winnerCount);
        result.put("winners", List.copyOf(winners));
        return result;
    }

    private static Map<String, Object> runNumberDraw(Session session) {
        int max = intConfig(session.config(), "maxNumber", 45);
        int count = intConfig(session.config(), "drawCount", 7);
        var pool = new ArrayList<Integer>(max);
        for (int number = 1; number <= max; number++) pool.add(number);
        secureShuffle(pool);
        List<Integer> numbers = new ArrayList<>(pool.subList(0, count));

        var result = new LinkedHashMap<String, Object>();
        result.put("mode", "NUMBER");
        result.put("maxNumber", max);
        result.put("drawCount", count);
        result.put("numbers", List.copyOf(numbers));
        return result;
    }

    private static <T> void secureShuffle(List<T> values) {
        for (int i = 0; i < values.size() - 1; i++) {
            int offset = RANDOM.nextInt(values.size() - i);
            Collections.swap(values, i, i + offset);
        }
    }

    private static void validateBeforeFreeze(Session session) {
        if ("RANDOM".equals(session.mode())) {
            int winnerCount = intConfig(session.config(), "winnerCount", 1);
            if (session.entries().isEmpty()) {
                throw new IllegalStateException("at least one entry is required");
            }
            if (winnerCount < 1 || winnerCount > session.entries().size()) {
                throw new IllegalStateException("winnerCount must be within entry count");
            }
            return;
        }

        int max = intConfig(session.config(), "maxNumber", 45);
        int count = intConfig(session.config(), "drawCount", 7);
        if (max < 1 || max > MAX_NUMBER) {
            throw new IllegalStateException("maxNumber must be 1.." + MAX_NUMBER);
        }
        if (count < 1 || count > Math.min(MAX_NUMBER_DRAW_COUNT, max)) {
            throw new IllegalStateException("drawCount must be 1.." + Math.min(MAX_NUMBER_DRAW_COUNT, max));
        }
    }

    private static Map<String, Object> normalizeConfig(String mode, Map<String, Object> raw) {
        var result = new LinkedHashMap<String, Object>();
        if ("RANDOM".equals(mode)) {
            result.put("winnerCount", intConfig(raw, "winnerCount", 1));
        } else {
            result.put("maxNumber", intConfig(raw, "maxNumber", 45));
            result.put("drawCount", intConfig(raw, "drawCount", 7));
        }
        return result;
    }

    private static int intConfig(Map<String, Object> config, String key, int fallback) {
        Object value = config.get(key);
        if (value instanceof Number number) return number.intValue();
        if (value instanceof String text) {
            try { return Integer.parseInt(text.trim()); }
            catch (NumberFormatException ignored) {}
        }
        return fallback;
    }

    private static List<String> normalizeManualEntries(List<String> raw) {
        if (raw == null) return List.of();
        var result = new ArrayList<String>();
        var seen = new java.util.LinkedHashSet<String>();
        for (String value : raw) {
            if (value == null) continue;
            String normalized = value.trim();
            if (normalized.isBlank()) continue;
            if (seen.add(normalized)) result.add(normalized);
            if (result.size() > MAX_ENTRIES) {
                throw new IllegalArgumentException("too many entries; max=" + MAX_ENTRIES);
            }
        }
        return List.copyOf(result);
    }

    private static String frozenHash(Session session) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            digest.update(session.mode().getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            digest.update(GSON.toJson(session.config()).getBytes(StandardCharsets.UTF_8));
            for (DrawEntry entry : session.entries()) {
                digest.update((byte) 0);
                digest.update(entry.entryId().getBytes(StandardCharsets.UTF_8));
                digest.update((byte) 0);
                digest.update(entry.label().getBytes(StandardCharsets.UTF_8));
            }
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (Exception error) {
            throw new IllegalStateException("failed to hash frozen entry set", error);
        }
    }

    private static String createPublicCode() {
        final String alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        StringBuilder value = new StringBuilder(6);
        for (int index = 0; index < 6; index++) {
            value.append(alphabet.charAt(RANDOM.nextInt(alphabet.length())));
        }
        return value.toString();
    }

    private static String normalizePublicCode(String value) {
        return value == null
            ? ""
            : value.trim().toUpperCase(Locale.ROOT);
    }

    private static String normalizeMode(String mode) {
        String normalized = mode == null ? "" : mode.trim().toUpperCase(Locale.ROOT);
        if (!normalized.equals("RANDOM") && !normalized.equals("NUMBER")) {
            throw new IllegalArgumentException("mode must be RANDOM or NUMBER");
        }
        return normalized;
    }

    private static String defaultName(String mode) {
        return mode.equals("NUMBER") ? "번호 추첨" : "시청자 랜덤 추첨";
    }
}
