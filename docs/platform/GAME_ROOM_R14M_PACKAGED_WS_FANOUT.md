# R14m — Actual Windows packaged JVM spectator WebSocket fanout

**Parent:** R14l Draft PR #94 at verified exact SHA \`ac034b1b6fdb3db31f63113918ea4582203f128f\`. Stacked Draft only; no merge, release, new production endpoint, database migration or third-party package.

## Gap this phase addresses

R14g/R14j thoroughly test 12 actual simultaneous sockets from a disposable Java test fixture, with SQLite replay and server transport restart, but **do not run those sockets against the distributed Windows app image**. R14k/R14l measure and exercise the real app-image listener-owning JVM with repeated HTTP and SQLite operations but no real spectator sockets. R14m adds that missing packaged-process-boundary acceptance.

## Test scope

The existing packaged smoke builds an isolated Yacht room in a disposable SQLite data root, uses three ephemeral localhost listeners and the production packaged EXE, then performs a normal graceful exit and restart with the original host bearer and room/chat verified. With the R14m opt-in, the room capacity is expanded **only for this test** to fit two successive groups of twelve spectators, plus the original host. Original Crash mode and R14k/R14l behavior without the opt-in are unchanged.

On each of the two actual Windows JVM lifecycles:

1. Admit **12 distinct authenticated spectators** by the existing public member-join HTTP endpoint. Verify separate bearer credentials.
2. Open twelve real Node 22+ native WebSockets to the **packaged server's listener** (not a fixture server). Authenticate each with a \`room.subscribe\` frame, never a URL bearer; verify an authorized \`room.snapshot\`. Pace connections 145ms apart, under the existing 24 connections per localhost IP and 120 handshakes per 10 seconds limits.
3. Commit a real host chat via REST while all twelve sockets are connected. Each spectator must receive the exact authorized \`room.chat.message\` with matching message ID, room and durable sequence (12 live deliveries).
4. Cleanly close all twelve sockets; commit another host chat while disconnected. Reconnect the same spectator credentials with \`afterSequence\` set to the prior live event's durable cursor. Every spectator must receive the missed event **exactly by its correct sequence** (12 durable replays), then close cleanly.
5. The PowerShell harness captures real working-set/private bytes, threads, handles and CPU counters **before and after** the socket workload using the proven R14k three-listener owner, executable lineage and loaded \`jvm.dll\` checks.
6. After both JVM lifecycles, two verified normal exits, all three port releases and room/chat recovery, persist a sanitized write-once schema-1 report.

Expected for two launches: **24 unique spectator memberships, 48 authenticated socket handshakes/snapshots, 24 live event deliveries, 24 replay deliveries and 48 clean closes**. Only twelve sockets are simultaneously connected per process. This is not 24 simultaneous sockets or a multi-host WAN trial.

The Node client receives fixture room code/ID and host token **only through transient environment variables**, never CLI args or logs; these values are cleared after each launch. Per-launch scratch reports are kept inside the disposable fixture root. Saved CI artifacts have an exact field allowlist: no bearer, member/room ID, room code, URL, IP, port, PID, command-line or chat content. Strict \`server/analyze-packaged-ws-fanout.mjs\` checks provenance, exact populations and phases, dual process resource deltas, release/recovery, ordering and self-test mutation cases.

## CI and limits

The Windows packaging and manual release workflows require this actual packaged WebSocket fanout and analyzer to pass **after** R14j isolated real WebSocket + R14k process provenance + R14l HTTP/SQLite workload and **before** publishing. Package CI retains non-secret report and summary separately as 14-day artifacts; the release workflow does not publish telemetry.

These are **bounded loopback** sockets and two brief process lifecycles, not production internet latency, long-running resource stability, multiple household IPs, certificate-validated external WSS, interactive Windows Explorer tray clicking, or a leak/leak-free claim. Separate field acceptance still requires external CA/proxy, a 24-hour multi-host workload, installer/upgrade/rollback and signing checks.

## Reproduction

Node 22+ and PowerShell 7+ on Windows, after packaging. Use fresh report paths:

    $r14k = Join-Path $env:TEMP 'r14k-process-new.json'
    $r14l = Join-Path $env:TEMP 'r14l-http-new.json'
    $r14m = Join-Path $env:TEMP 'r14m-ws-new.json'
    ./server/smoke-packaged-game-room-restart.ps1 -StopMode Graceful -TelemetryPath $r14k -LoadRounds 24 -LoadReportPath $r14l -WsSpectators 12 -WsReportPath $r14m
    node ./server/analyze-packaged-ws-fanout.mjs --self-test
    node ./server/analyze-packaged-ws-fanout.mjs "--input=$r14m" "--summary=./new-r14m-summary.json"

All paths must not exist. No production service or user data is required.
