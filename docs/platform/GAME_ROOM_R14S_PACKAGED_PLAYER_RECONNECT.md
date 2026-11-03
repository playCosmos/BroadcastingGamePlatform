# R14s — Actual packaged Yacht player reconnect and multi-turn verification

Parent R14r Draft PR #100, verified SHA 2569f5d75c9e42e0e4b158e03f1936f1c98118ee. Separate stacked Draft; never merge/release as part of automated testing.

## Purpose and coverage

R14r already proves the real Windows packaged EXE can gracefully restart with its persistent SQLite game state and two distinct Yacht players, an unfinished roll, authenticated guest chat and a resumed score/roll. R14s extends this **same disposable actual Windows JVM fixture** with both players' real authenticated WebSocket sessions and four more scored turns. It is neither a mocked Yacht engine nor a public multi-IP or 24-hour test.

In BOTH real packaged process lifetimes, after R14r has passed, R14s authenticates both distinct existing room members, subscribes two simultaneous WebSocket sessions with room-scoped snapshots, commits guest chat and verifies it reached both sockets live. It then closes one player socket, commits a second chat while disconnected, reconnects with the *last received sequence cursor* and proves the missed message arrived as genuine replay. A final host chat must arrive on both active sockets; sessions are closed with normal codes.

After the actual Windows process restart, R14s first proves its previous-lifetime chat is still in SQLite through authenticated HTTP lookup and through WSS event replay. It then keeps both player WebSockets open throughout a series of real HTTP Yacht actions: the guest scores ACES from the R14r resumed roll; the host rolls and scores TWOS; the guest rolls and scores THREES; and the host rolls and scores FOURS. The test verifies turn ownership, exact match ID, expected version/committed version advancement, authoritative completed-turn count, and two still-open player sockets after every turn. In combination with the original R14r host CHANCE score this reaches **five completed turns** after restart.

These are genuine HTTP Yacht game actions performed while player sockets are open; the socket is NOT claimed to transmit the game move itself or to receive a separate Yacht-game-action push event. The 12-spectator R14m/n live chat/replay test remains independent in another room.

## Security and boundaries

The PowerShell harness launches only the existing real packaged EXE on three unique localhost listeners with a disposable SQLite DB. Member bearer tokens, member IDs, room UUID, chat content, random dice results and actual process/port details never appear in the final report. The local fixture worker receives credentials through inherited process environment and writes only sanitary booleans/counts to a disposable temporary JSON stage file. Reports and summaries are write-once and contain no secret data. The complete R14s evidence is written only after the second JVM's graceful stop and verified listener port release.

The strict analyzer verifies two actual process lifetimes, three authenticated socket snapshots per process, three clean closes each, live/replayed event counts, durable cross-restart chat and four post-restart Yacht scored turns. Windows package CI and manual release gate require this **actual packaged run and strict analyzer**, not just synthetic tests; negative mutation self-tests prevent corrupted/secret-bearing evidence passing.

## How to run on Windows

Build the Windows packaged app-image first. Choose six unique new output paths for R14k/l/m/n/r/s and a separate new summary path. In PowerShell 7 run:

    ./server/smoke-packaged-game-room-restart.ps1 -StopMode Graceful -TelemetryPath $r14k -LoadRounds 24 -LoadReportPath $r14l -WsSpectators 12 -WsReportPath $r14m -WsSoakCycles 6 -WsSoakReportPath $r14n -YachtReportPath $r14r -YachtWsReportPath $r14s
    node ./server/analyze-packaged-yacht-player-ws.mjs --self-test
    node ./server/analyze-packaged-yacht-player-ws.mjs "--input=$r14s" "--summary=$newSummary"

No real production accounts or public endpoint is used. Actual external 24-hour observations, continuous gameplay across network/JVM outages, physical multi-PC/WAN, signed installer, tray interaction, upgrade and rollback remain to be verified separately.
