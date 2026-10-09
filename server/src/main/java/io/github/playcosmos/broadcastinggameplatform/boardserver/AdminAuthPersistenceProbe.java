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
                    && "PENDING".equals(pending.status())
                    && "ABC7K2".equals(pending.code()),
                "approval request must survive store recreation"
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
