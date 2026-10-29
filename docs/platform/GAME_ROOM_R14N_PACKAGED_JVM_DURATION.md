# R14n — Bounded packaged Windows JVM duration trend

**Parent:** R14m Draft PR #95 at the exact Windows CI-verified SHA \`495433085d5ea89ccfb19bf9e786548bb6b2e1b5\`. Stacked Draft only; not a merge or release.

## Purpose

R14m proved 12 simultaneous, authenticated WebSocket spectators can receive actual committed chat and reconnect with durable cursor replay against the packaged Windows server's **real JVM**. Its two short waves alone cannot reveal whether resources drift while the same process repeatedly performs that workload. R14n extends those tests to repeated cycles with **periodically sampled JVM resource counters**, while preserving the original R14m one-cycle acceptance.

## Bounded test setup

Use the real Windows jpackage EXE, three ephemeral localhost listeners, a disposable Yacht room and SQLite, with SOOP disabled. Its existing two graceful process lifecycles, original bearer and room/chat persistence across a restart, and full port-release checks remain unchanged.

The opt-in R14n mode reuses the same **12 distinct spectator identities within each lifecycle**, not creating a new spectator per cycle. For each of **six cycles per JVM lifecycle**, the Node 22+ WebSocket client:

1. Authenticates and verifies twelve individual snapshots over twelve simultaneous real sockets, under built-in localhost and handshake limits (connections paced 145ms).
2. Persists one host chat and asserts **all twelve** spectators receive the correct live message and room/sequence.
3. Cleanly closes all twelve sockets; persists a second host chat while offline.
4. Reconnects the same 12 identities from the last durable cursor, verifies each missed committed event and cleanly closes all twelve sockets.
5. Waits six seconds between cycles (five gaps, 30 seconds per process). Each actual packaged JVM process stays running continuously during all six cycles.

Expected: **12 cycles total across two process lifecycles, 288 authentications and clean closes, 144 live deliveries, 144 durable replays**. The original R14m report still describes the first cycle (24 handshakes and 12+12 event deliveries per process); R14n has a separate report of all six cycles. R14m's before/after JVM resource counters cover the full opt-in session, so **use the R14n report** for multi-cycle resource trend comparisons.

While the child native WebSocket client runs, PowerShell samples the **actual packaged listener-owning JVM** at approximately 5-second intervals using the validated R14k process identity procedure (three owning ports, descendant/executable within app image, and loaded \`jvm.dll\`). A 240-second worker watchdog prevents unbounded CI activity. The harness records a baseline sample, periodically captures working set, private memory, threads, handles, CPU time, and captures the final sample. The client reports ordered per-cycle completion and elapsed times, all without storing any bearer, room/member ID, IP, port, URL, PID, chat text or command line.

Reports are created once only after both normal shutdowns, port release and room/session recovery, and are retained in package CI for 14 days separately from R14j/R14k/R14l/R14m. The manual release workflow requires the same bounded test and strict analyzer before publishing.

## Verification and limitations

The independent schema-1 \`analyze-packaged-ws-duration.mjs\` enforces exactly two launch series with six complete cycles each, 12 spectators per lifecycle, full live and replay delivery counts, a minimum 30-second per-process duration, **at least seven real JVM samples**, time/CPU monotonicity, valid counters, complete replay/restart/port-release attestations and strict no-secret field allowlists. It produces per-process cycle p50/p95/max, resource starting/ending/peak values and differences. Mutation self-tests reject truncated/reordered cycles, provenance failures, invalid metrics and secret fields.

**A successful CI run is not a 24-hour soak, memory-leak verdict, production performance benchmark or external WSS security test**. Pauses and socket pacing make this a bounded localhost test; neither GC nor JVM warmup nor CI host OS scheduling are controlled. Real physical Windows tray interaction, signed installer/upgrade/rollback, external public HTTPS/WSS and certificate/proxy checks, and multi-PC 24-hour continuous use still need independent field acceptance.

## Windows reproduction

After building the actual Windows app image, in PowerShell 7+ use fresh output paths:

    $report = Join-Path $env:TEMP 'r14k-new.json'
    $load = Join-Path $env:TEMP 'r14l-new.json'
    $ws = Join-Path $env:TEMP 'r14m-new.json'
    $duration = Join-Path $env:TEMP 'r14n-new.json'
    ./server/smoke-packaged-game-room-restart.ps1 -StopMode Graceful -TelemetryPath $report -LoadRounds 24 -LoadReportPath $load -WsSpectators 12 -WsReportPath $ws -WsSoakCycles 6 -WsSoakReportPath $duration
    node ./server/analyze-packaged-ws-duration.mjs --self-test
    node ./server/analyze-packaged-ws-duration.mjs "--input=$duration" "--summary=./r14n-new-summary.json"

No production endpoint, external provider or live account is involved. All output files must not exist before running. Record the exact-head push and independent PR Windows checks before declaring a milestone accepted.
