package io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw;

import com.google.gson.Gson;
import io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabase;
import io.github.playcosmos.broadcastinggameplatform.platform.events.ChatMessageEvent;
import java.nio.file.Files;
import java.time.Instant;
import java.util.List;
import java.util.Map;

public final class ViewerDrawProbe {
    private ViewerDrawProbe() {}

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory("platform-viewer-draw-probe-");
        var database = new BoardGameDatabase(root.resolve("platform.db"));
        database.initialize();
        var service = new ViewerDrawService(database);

        var random = service.create(
            "random",
            "RANDOM",
            List.of("A", "B", "C", "C"),
            Map.of("winnerCount", 2)
        );
        require(random.entryCount() == 3, "manual entries must be deduplicated");
        random = service.freeze(random.sessionId());
        require("FROZEN".equals(random.state()), "random session must freeze");
        require(random.frozenEntryHash() != null, "frozen entry hash required");
        random = service.start(random.sessionId());
        require("COMPLETED".equals(random.state()), "random draw must complete");
        var randomResult = castMap(random.result());
        require(castList(randomResult.get("winners")).size() == 2, "two winners expected");

        var number = service.create(
            "numbers",
            "NUMBER",
            List.of(),
            Map.of("maxNumber", 45, "drawCount", 7)
        );
        number = service.freeze(number.sessionId());
        number = service.start(number.sessionId());
        var numberResult = castMap(number.result());
        var numbers = castList(numberResult.get("numbers"));
        require(numbers.size() == 7, "seven numbers expected");
        require(new java.util.HashSet<>(numbers).size() == 7, "number draw must be unique");
        require(
            numbers.stream().allMatch(value -> {
                int n = ((Number) value).intValue();
                return n >= 1 && n <= 45;
            }),
            "numbers must remain within range"
        );

        require(service.recent(10).size() == 2, "history must persist both draws");

        boolean oversizedNameRejected = false;
        try {
            service.create(
                "x".repeat(81),
                "RANDOM",
                List.of("A"),
                Map.of("winnerCount", 1)
            );
        } catch (IllegalArgumentException expected) {
            oversizedNameRejected = true;
        }
        require(
            oversizedNameRejected,
            "oversized viewer draw session name must be rejected"
        );

        boolean oversizedManualRejected = false;
        try {
            service.create(
                "oversized-manual",
                "RANDOM",
                List.of("x".repeat(257)),
                Map.of("winnerCount", 1)
            );
        } catch (IllegalArgumentException expected) {
            oversizedManualRejected = true;
        }
        require(
            oversizedManualRejected,
            "oversized manual entry must be rejected"
        );

        boolean oversizedStructuredRejected = false;
        try {
            service.create(
                "oversized-structured",
                "RANDOM",
                "IMPORTED_SET",
                List.of(
                    new ViewerDrawService.DrawEntry(
                        "entry-1",
                        "SOOP",
                        "u".repeat(257),
                        "Viewer",
                        "Viewer"
                    )
                ),
                Map.of("winnerCount", 1)
            );
        } catch (IllegalArgumentException expected) {
            oversizedStructuredRejected = true;
        }
        require(
            oversizedStructuredRejected,
            "oversized structured entry field must be rejected"
        );

        var collection = service.openChatEntryCollection(
            "SOOP",
            "channel-a",
            "!참가,!join"
        );
        require(
            "OPEN".equals(collection.state())
                && collection.entryCount() == 0,
            "chat entry collection must open empty"
        );

        require(
            !service.processChatMessage(
                chat("SOOP", "channel-a", "u0", "Wrong", "hello")
            ),
            "unmatched chat must not enter collection"
        );
        require(
            service.processChatMessage(
                chat("SOOP", "channel-a", "u1", "Viewer 1", "!참가")
            ),
            "matching SOOP keyword must add viewer"
        );
        require(
            !service.processChatMessage(
                chat(
                    "SOOP",
                    "channel-a",
                    "u".repeat(257),
                    "Oversized",
                    "!참가"
                )
            ),
            "oversized chat identity must not enter collection"
        );
        require(
            !service.processChatMessage(
                chat("SOOP", "channel-a", "u1", "Viewer 1", "!join")
            ),
            "provider user identity must deduplicate chat entry"
        );
        require(
            !service.processChatMessage(
                chat("SOOP", "other", "u2", "Viewer 2", "!참가")
            ),
            "configured channel must be respected"
        );

        service.pauseEntryCollection();
        require(
            !service.processChatMessage(
                chat("SOOP", "channel-a", "u2", "Viewer 2", "!참가")
            ),
            "paused collection must reject chat"
        );
        service.resumeEntryCollection();
        require(
            service.processChatMessage(
                chat("SOOP", "channel-a", "u2", "Viewer 2", "!join")
            ),
            "resumed collection must accept chat"
        );

        collection = service.closeEntryCollection();
        require(
            "CLOSED".equals(collection.state())
                && collection.entryCount() == 2
                && collection.duplicateMessages() == 1,
            "chat collection snapshot mismatch"
        );

        var chatRandom = service.create(
            "chat-random",
            "RANDOM",
            "CHAT_KEYWORD",
            collection.entries(),
            Map.of("winnerCount", 1)
        );
        require(
            "CHAT_KEYWORD".equals(chatRandom.entrySource())
                && chatRandom.entryCount() == 2
                && "SOOP".equals(chatRandom.entries().get(0).provider())
                && chatRandom.entries().get(0).userId() != null,
            "chat identity must persist into viewer draw session"
        );
        chatRandom = service.freeze(chatRandom.sessionId());
        require(
            chatRandom.frozenEntryHash() != null,
            "chat session must freeze with identity-aware hash"
        );
        chatRandom = service.start(chatRandom.sessionId());
        var publicChatRandom = service.findPublicSessionByCode(
            chatRandom.publicCode()
        );
        String publicChatRandomJson = new Gson().toJson(
            publicChatRandom
        );
        require(
            publicChatRandomJson.contains("\"displayName\"")
                && publicChatRandomJson.contains("\"label\""),
            "public random result must retain winner presentation"
        );
        require(
            !publicChatRandomJson.contains("\"provider\"")
                && !publicChatRandomJson.contains("\"userId\"")
                && !publicChatRandomJson.contains("\"entryId\""),
            "public random result must hide provider identity"
        );

        var savedAudit = service.saveMarbleAudit(
            Map.of(
                "schemaVersion", "viewer-draw-run-audit/v0",
                "resultStatus", "COMPLETED",
                "qualification", Map.of(
                    "status", "QUALIFIED",
                    "reasons", List.of(),
                    "qualificationMinWinners", 1,
                    "qualificationMaxNudges", 5
                ),
                "map", Map.of(
                    "name", "Public Audit Probe",
                    "definitionHash", "a".repeat(64)
                ),
                "entries", Map.of(
                    "count", 2,
                    "snapshotHash", "b".repeat(64)
                ),
                "engine", Map.of(
                    "id", "BOX2D_WASM",
                    "fixedTimestepSeconds", 1.0 / 120.0
                ),
                "run", Map.of(
                    "seed", 1234,
                    "startedAt", "2026-10-09T00:00:00Z",
                    "completedAt", "2026-10-09T00:00:10Z",
                    "simulationSeconds", 10,
                    "stuckNudges", 0
                ),
                "result", Map.of(
                    "winners", List.of(
                        Map.of(
                            "rank", 1,
                            "entryId", "secret-entry-id",
                            "displayName", "Winner A"
                        )
                    ),
                    "finishOrder", List.of(
                        Map.of("entryId", "secret-finish-id")
                    ),
                    "eliminationOrder", List.of(
                        Map.of("entryId", "secret-elimination-id")
                    ),
                    "dnf", List.of(
                        Map.of("entryId", "secret-dnf-id")
                    ),
                    "outputClaims", List.of(
                        Map.of("entryId", "secret-output-id")
                    )
                )
            )
        );
        var publicAudit = service.findPublicMarbleAuditByPublicCode(
            savedAudit.publicCode()
        );
        String publicAuditJson = new Gson().toJson(publicAudit);
        require(
            publicAuditJson.contains("\"CLIENT_REPORTED\"")
                && publicAuditJson.contains("\"independentlyVerified\":false")
                && publicAuditJson.contains("\"serverPhysicsReplayed\":false"),
            "public marble audit must disclose that server did not verify physics"
        );
        require(
            publicAuditJson.contains("Winner A"),
            "public marble audit must retain winner display name"
        );
        require(
            publicAuditJson.contains("\"dnfCount\":1"),
            "public marble audit must retain DNF count"
        );
        require(
            !publicAuditJson.contains("entryId")
                && !publicAuditJson.contains("finishOrder")
                && !publicAuditJson.contains("eliminationOrder")
                && !publicAuditJson.contains("outputClaims")
                && !publicAuditJson.contains("secret-"),
            "public marble audit must not expose internal entry detail"
        );

        for (int index = 0; index < 200; index += 1) {
            service.saveMarbleAudit(savedAudit.audit());
        }
        require(
            countMarbleAudits(database) == 200,
            "marble audit history must retain only the latest 200 audits"
        );

        var oversizedAudit = new java.util.LinkedHashMap<String, Object>(
            savedAudit.audit()
        );
        oversizedAudit.put("padding", "가".repeat(400_000));
        boolean oversizedAuditRejected = false;
        try {
            service.saveMarbleAudit(oversizedAudit);
        } catch (IllegalArgumentException expected) {
            oversizedAuditRejected = true;
        }
        require(
            oversizedAuditRejected,
            "marble audit limit must be enforced by UTF-8 byte size"
        );

        var retainedDraft = service.create(
            "retained-draft",
            "NUMBER",
            List.of(),
            Map.of("maxNumber", 45, "drawCount", 1)
        );
        seedTerminalSessions(database, 205);

        var retentionTrigger = service.create(
            "retention-trigger",
            "NUMBER",
            List.of(),
            Map.of("maxNumber", 45, "drawCount", 1)
        );
        retentionTrigger = service.freeze(
            retentionTrigger.sessionId()
        );
        retentionTrigger = service.start(
            retentionTrigger.sessionId()
        );
        require(
            "COMPLETED".equals(retentionTrigger.state()),
            "retention trigger draw must complete"
        );
        require(
            countTerminalSessions(database) == 200,
            "terminal Viewer Draw sessions must retain only the latest 200"
        );
        require(
            "DRAFT".equals(
                service.find(retainedDraft.sessionId()).state()
            ),
            "Viewer Draw retention must not prune active DRAFT sessions"
        );

        System.out.println("Viewer Draw probe passed.");
    }

    private static void seedTerminalSessions(
        BoardGameDatabase database,
        int count
    ) throws Exception {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try (var statement = connection.prepareStatement("""
                INSERT INTO viewer_draw_session(
                  session_id, public_code, name, mode,
                  entry_source, state, config_json,
                  frozen_entry_hash, entry_count,
                  created_at, updated_at, completed_at
                ) VALUES (?, ?, ?, 'NUMBER', 'MANUAL_LIST',
                          'COMPLETED', ?, NULL, 0, ?, ?, ?)
                """)) {
                for (int index = 0; index < count; index += 1) {
                    String sessionId = "retention-old-" + index;
                    String publicCode = String.format(
                        java.util.Locale.ROOT,
                        "0%05d",
                        index
                    );
                    String timestamp = String.format(
                        java.util.Locale.ROOT,
                        "2020-01-01T00:%02d:%02dZ",
                        (index / 60) % 60,
                        index % 60
                    );
                    statement.setString(1, sessionId);
                    statement.setString(2, publicCode);
                    statement.setString(
                        3,
                        "Retention Old " + index
                    );
                    statement.setString(
                        4,
                        "{\"maxNumber\":45,\"drawCount\":1}"
                    );
                    statement.setString(5, timestamp);
                    statement.setString(6, timestamp);
                    statement.setString(7, timestamp);
                    statement.addBatch();
                }
                statement.executeBatch();
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                throw error;
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private static int countTerminalSessions(
        BoardGameDatabase database
    ) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT COUNT(*)
                 FROM viewer_draw_session
                 WHERE state IN ('COMPLETED', 'CANCELLED')
                 """);
             var rows = statement.executeQuery()) {
            return rows.next() ? rows.getInt(1) : -1;
        }
    }

    private static int countMarbleAudits(
        BoardGameDatabase database
    ) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement(
                 "SELECT COUNT(*) FROM viewer_draw_marble_audit"
             );
             var rows = statement.executeQuery()) {
            return rows.next() ? rows.getInt(1) : -1;
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }

    private static ChatMessageEvent chat(
        String provider,
        String channelId,
        String userId,
        String nickname,
        String message
    ) {
        return new ChatMessageEvent(
            provider,
            channelId,
            userId,
            nickname,
            message,
            "{}",
            Instant.now().toEpochMilli()
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
