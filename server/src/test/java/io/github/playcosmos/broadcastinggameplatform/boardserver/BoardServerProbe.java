package io.github.playcosmos.broadcastinggameplatform.boardserver;

public final class BoardServerProbe {
    private BoardServerProbe() {}

    public static int run() {
        int exitCode = BoardServerSelfCheck.run();
        if (exitCode == 0) {
            System.out.println("[board-server-probe] PASS");
        }
        return exitCode;
    }
}
