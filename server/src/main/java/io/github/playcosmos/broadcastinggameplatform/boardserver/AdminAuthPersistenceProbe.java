package io.github.playcosmos.broadcastinggameplatform.boardserver;

import java.nio.file.Files;
import java.time.Instant;

public final class AdminAuthPersistenceProbe {
    private AdminAuthPersistenceProbe() {}

    public static void main(String[] args) {
        System.exit(run());
    }

    public static int run() {
        try {
            var root = Files.createTempDirectory(
                "ramyani-admin-auth-probe-"
            );
            var database = new BoardGameDatabase(
                root.resolve("data/board-game.db")
            );
            database.initialize();

            require(
                !tableExists(database, "board_admin_auth_state"),
                "bootstrap token must not be persisted in the database"
            );

            var firstStore = new AdminAuthStore(database);
            Instant initialExpiry = Instant.now().plusSeconds(3600);
            firstStore.createSession("probe-session", initialExpiry);

            var reopenedStore = new AdminAuthStore(database);
            require(
                initialExpiry.equals(
                    reopenedStore.sessionExpiresAt("probe-session")
                ),
                "admin session must survive store recreation"
            );

            var reopenedAgain = new AdminAuthStore(database);

            Instant approvalExpiry = Instant.now().plusSeconds(600);
            require(
                reopenedAgain.createApprovalRequest(
                    "approval-request-secret",
                    "ABC7K2",
                    approvalExpiry
                ),
                "approval request must be created"
            );
            var approvalReopened = new AdminAuthStore(database);
            var pending = approvalReopened.findApprovalRequest(
                "approval-request-secret",
                Instant.now()
            );
            require(
                pending != null
                    && "PENDING".equals(pending.status()),
                "approval request must survive store recreation"
            );
            require(
                !approvalCodeStoredAsPlaintext(
                    database,
                    "ABC7K2"
                ),
                "administrator approval code must not be stored in plaintext"
            );
            require(
                storedApprovalCode(database).startsWith("v2."),
                "administrator approval code must use process-keyed HMAC storage"
            );
            require(
                approvalReopened.approveApprovalRequest(
                    "ABC7K2",
                    Instant.now()
                ),
                "approval code must be approvable"
            );
            require(
                approvalReopened.consumeApprovedApprovalRequest(
                    "approval-request-secret",
                    "approved-session",
                    Instant.now().plusSeconds(3600),
                    Instant.now()
                ),
                "approved request must exchange for a session"
            );
            require(
                approvalReopened.findApprovalRequest(
                    "approval-request-secret",
                    Instant.now()
                ) == null,
                "approved request must be one-time"
            );
            require(
                approvalReopened.sessionExpiresAt(
                    "approved-session"
                ) != null,
                "approved session must persist"
            );

            insertStaleApprovalRow(database);
            approvalReopened.cleanupExpiredApprovalRequests(
                Instant.now()
            );
            require(
                !approvalRequestHashExists(
                    database,
                    "legacy-request-hash"
                ),
                "approval rows from another process key must be invalidated"
            );

            int revoked = reopenedAgain.revokeAllSessions();
            require(
                revoked >= 1,
                "session revocation must report active sessions"
            );
            require(
                reopenedAgain.sessionExpiresAt("probe-session") == null,
                "session revocation must remove existing sessions"
            );

            System.out.println(
                "Admin auth persistence probe passed."
            );
            return 0;
        } catch (Exception error) {
            error.printStackTrace();
            return 1;
        }
    }

    private static String storedApprovalCode(
        BoardGameDatabase database
    ) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT approval_code
                 FROM board_admin_approval_request
                 LIMIT 1
                 """);
             var rows = statement.executeQuery()) {
            return rows.next() ? rows.getString(1) : "";
        }
    }

    private static void insertStaleApprovalRow(
        BoardGameDatabase database
    ) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 INSERT INTO board_admin_approval_request(
                   request_hash, approval_code, status,
                   expires_at, created_at, approved_at
                 ) VALUES (?, ?, 'PENDING', ?, ?, NULL)
                 """)) {
            statement.setString(1, "legacy-request-hash");
            statement.setString(2, "legacy-sha256-like-value");
            statement.setString(
                3,
                Instant.now().plusSeconds(600).toString()
            );
            statement.setString(4, Instant.now().toString());
            statement.executeUpdate();
        }
    }

    private static boolean approvalRequestHashExists(
        BoardGameDatabase database,
        String requestHash
    ) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT 1
                 FROM board_admin_approval_request
                 WHERE request_hash = ?
                 """)) {
            statement.setString(1, requestHash);
            try (var rows = statement.executeQuery()) {
                return rows.next();
            }
        }
    }

    private static boolean approvalCodeStoredAsPlaintext(
        BoardGameDatabase database,
        String approvalCode
    ) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT approval_code
                 FROM board_admin_approval_request
                 LIMIT 1
                 """);
             var rows = statement.executeQuery()) {
            return rows.next()
                && approvalCode.equals(rows.getString(1));
        }
    }

    private static boolean tableExists(
        BoardGameDatabase database,
        String tableName
    ) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT 1
                 FROM sqlite_master
                 WHERE type = 'table' AND name = ?
                 """)) {
            statement.setString(1, tableName);
            try (var rows = statement.executeQuery()) {
                return rows.next();
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
