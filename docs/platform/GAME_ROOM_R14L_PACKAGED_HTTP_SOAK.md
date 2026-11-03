# R14l — Bounded packaged JVM HTTP/SQLite workload acceptance

Parent: R14k Draft PR #93 at exact verified SHA 823ad0580dad73dd24912d3eee9a15cde476191e. This is a stacked Draft branch, not a merge or release.

## Why

R14j exercises real Drawing/Yacht WebSocket and SQLite but samples a disposable Java fixture, not the distributable Windows EXE. R14k verifies and samples the actual packaged listener-owning JVM but performs only one chat write and a short recovery. R14l adds bounded repeatable HTTP and SQLite workload against the same real packaged JVM **before and after graceful restart**.

This is not a production, long-duration, WAN or concurrent spectator stress test.

## Workload

The existing packaged smoke runs the actual Windows jpackage EXE with disposable loopback ports/SQLite, hosts a real Yacht room, commits chat, shuts down via the normal production callback, restarts with same SQLite/member bearer, verifies room and chat, then exits normally again. The original Crash mode and four R14k schema-2 samples remain supported.

With LoadRounds=24 and fresh separate report filenames, the test performs **24 rounds on each of two real process lifecycles**:

1. GET public Yacht room directory; verify hosted room remains.
2. GET authenticated member session; verify original bearer remains mapped.
3. GET authenticated chat history; verify original and latest committed message.
4. Every sixth round, POST one unique authenticated chat before the history query.

This totals **48 rounds, 144 HTTP reads and 8 real chat writes** (152 operations). A 120ms delay between rounds limits interference from anti-abuse controls. These are sequential requests, not concurrent load. Each round measures duration and samples the listener-owning packaged JVM process after revalidating its three TCP listeners, package ancestry/executable location and loaded jvm.dll.

Reports store only predefined launch/round, request counts, writes, round duration, working set, private bytes, thread count, handle count and CPU time. No bearer, PID, room ID, IP, port, chat content or command line is saved. A schema-1 JSON report is created exclusively after both graceful exits, recovered room/chat and released listeners; existing files are not overwritten.

## Validation and publication gates

The dependency-free Node analyzer requires strict schema/allowlisted fields, exactly two ordered launches, 24 complete rounds each, three GETs per round, chat POST every sixth round, positive resource counts, nondecreasing CPU time within each process, and positive round duration. It rejects truncation, tampering, unknown secret fields, unsupported process provenance, missing recovery and listener release. Summary reports per-launch HTTP round p50/p95/max and descriptive JVM resource deltas; it does not impose arbitrary leak thresholds.

Both package CI and manual release workflows must run and validate the R14l workload before artifact upload/release creation. Ordinary CI alone retains the sanitized report and summary in a separate 14-day artifact. R14j's 24-round isolated real WebSocket fixture and R14k's four-sample packaged JVM report remain separately required.

## Limits

- 48 sequential localhost rounds do not establish 24-hour reliability, production performance or multi-host throughput.
- The same JVM counters may increase or decrease due to warmup, GC, OS allocation or CI runner variability; neither change proves a memory leak or leak freedom.
- This workload does not create WebSocket spectators or exercise public HTTPS/WSS. The existing browser and independent Java transport gates remain necessary.
- External-network TLS/proxy checks, physical Windows tray clicking, 24-hour resource measurements, installer/upgrades/rollback and signing require real field acceptance.

## Windows PowerShell reproduction

After building the Windows app image, use fresh report filenames:

    $r14k = Join-Path $env:TEMP 'r14k-process.json'
    $r14l = Join-Path $env:TEMP 'r14l-http-soak.json'
    $summary = Join-Path $env:TEMP 'r14l-summary.json'
    ./server/smoke-packaged-game-room-restart.ps1 -StopMode Graceful -TelemetryPath $r14k -LoadRounds 24 -LoadReportPath $r14l
    node ./server/analyze-packaged-http-soak.mjs --self-test
    node ./server/analyze-packaged-http-soak.mjs "--input=$r14l" "--summary=$summary" --min-rounds=24

An exact-head Windows CI success is required before treating this feature as accepted.
