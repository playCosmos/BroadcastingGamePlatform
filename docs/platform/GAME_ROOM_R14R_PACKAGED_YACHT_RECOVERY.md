# R14r — Actual packaged Windows Yacht/guest chat recovery acceptance

**Parent:** R14q Draft PR #99, exact verified parent SHA 5f19df80dfe11da7c63126855516c040393ecad1. Separate Draft only; no merge or release.

## Coverage goal

R14j–n already verify actual packaged Windows listener-JVM identity, HTTP and SQLite workload, twelve real WebSocket spectators, chat fanout, durable cursor replay and continuous concurrent-session reconnection over two approximately one-minute process lifetimes. R14o–q supply separate **operator-run 24-hour field observation tools**, which have NOT been executed on a physical field system.

R14r adds actual **game-state progression** to the bounded real Windows packaged-EXE acceptance. It creates an independent Yacht game room inside the SAME isolated test JVM, not in the R14m spectator room. Each game room uses genuine HTTP-created bearer credentials, game membership and SQLite; no fake Yacht state, simulated server or imported unit-test engine.

## End-to-end steps

In the first packaged Windows JVM lifetime, with three isolated loopback ports and a disposable SQLite database:

1. Host a Yacht room with two player seats; a **different member** joins the room as the second player (the test compares issued IDs).
2. Both players enter the ready state, and only the host starts the game. Assert the shared GameRoom enters PLAYING and the server-authoritative Yacht match is ACTIVE.
3. The host submits an actual Yacht dice-roll command with its expected match version; assert a committed version advance and exactly five dice. Keep the match ID, version and dice in **memory only**.
4. The distinct guest commits an actual GameRoom chat message; keep its event sequence **in memory only**.
5. Allow the existing real packaged-JVM graceful shutdown to finish, verify all three listener ports are released, and relaunch the **same actual EXE** over the same SQLite DB.

In the second packaged JVM lifetime:

1. Using the **original host and guest bearer credentials**, read both identities and the Yacht match. Check the exact original match ID, all five die values in order, committed version and one ongoing roll with no completed turn.
2. Retrieve the guest's chat message via REST durable replay and assert the original committed message ID and sequence.
3. The host scores the rolled dice into the valid unclaimed CHANCE category, strictly advancing the completed turn and transitioning to the second player's turn.
4. Confirm the second player's bearer now has the authoritative turn; have the guest issue a new real dice-roll command with the updated version, proving post-restart state mutation and turn ownership.
5. Complete the second graceful shutdown and port-release check; only THEN write the sanitized R14r report.

The preexisting R14m/n 12-spectator fanout/reconnect fixture runs unchanged in its **own** room. It is not allowed to be confused with the two-player match. The resulting combined Windows acceptance now covers both spectator chat replay and genuine two-player gameplay, but does **not** constitute a 24-hour or WAN test.

## Reports and CI

Package and manual release workflow both pass a fresh distinct R14r JSON path to the existing packaged-graceful test and enforce the strict R14r analyzer before artifact publication/release. Package CI retains sanitized R14r report and summary for 14 days, separate from R14j–n.

The output contains only boolean assertions and counts: two unique players, two process lifetimes, roll counts, completed turn, durable guest chat recovery, exact in-memory match ID/dice/version recovery, guest post-restart turn operation, JVM owner/module provenance, one restart, two graceful exits and three released listeners. **No member bearer, room code/UUID, member ID, die face, client IP, process ID or chat text** is published. The independent analyzer rejects missing lifecycle flags, reordered stages, incomplete gameplay, false durability flags or secret/unexpected fields and runs its own mutation selftests.

This is bounded CI against a disposable localhost actual Windows app-image, not a 24-hour/physical computer/WAN/persistent socket test. Real external HTTPS/WSS, continuous interactive players, drawing modes, signed installer upgrades and Windows tray clicking need separate field acceptance.

## Reproduction on Windows CI-capable host

After building the real app-image, in PowerShell 7+ choose **fresh unique** output paths and execute:

    $out = $env:TEMP
    ./server/smoke-packaged-game-room-restart.ps1 -StopMode Graceful -TelemetryPath (Join-Path $out "r14k-new.json") -LoadRounds 24 -LoadReportPath (Join-Path $out "r14l-new.json") -WsSpectators 12 -WsReportPath (Join-Path $out "r14m-new.json") -WsSoakCycles 6 -WsSoakReportPath (Join-Path $out "r14n-new.json") -YachtReportPath (Join-Path $out "r14r-new.json")
    node ./server/analyze-packaged-yacht-recovery.mjs --self-test
    node ./server/analyze-packaged-yacht-recovery.mjs "--input=$out\r14r-new.json" "--summary=$out\r14r-new-summary.json"

Inputs and outputs are disposable, without live accounts or public test endpoints. All report paths must be new. If CI fails, do not treat the milestone as accepted; verify the **exact HEAD SHA** has completed a green Windows run and contains actual packaged two-JVM test markers.
