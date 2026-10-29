# R14k — Windows EXE process telemetry before distribution

Parent: R14j Draft PR #92, verified exact SHA ce931ee3ea78638eef6bf1c187fe34a897dde831. This is a stacked Draft, not a merge or release.

## Motivation

R14j samples a disposable Java fixture during real Drawing/Yacht WebSocket reconnect and SQLite workload. Its JVM samples cannot describe the distributable Windows EXE. R14k adds process-level observations to the existing R14h **actual packaged EXE** graceful shutdown/restart test without inventing memory-leak thresholds.

## Workload and samples

The existing test starts the app from the Windows package with disposable loopback config and storage, opens a Yacht room, posts member chat, performs the production graceful-exit callback, restarts with the same SQLite/member token, verifies persisted room/chat and cleanly exits a second time.

R14k samples only that running **Windows EXE process** at four points:

| Launch | Phase | Verified event |
| --- | --- | --- |
| 1 | ready | Initial public room endpoint responds |
| 1 | afterChat | Hosted room and authenticated chat saved |
| 2 | ready | Restarted EXE serves public room listing |
| 2 | afterReplay | Original room, member session and chat restored |

Only working-set bytes, private memory bytes, handle count, thread count and process CPU milliseconds are recorded; rows have a launch number and predefined phase. The script records **no bearer, PID, IP address, room ID, chat content or other user data**. The optional file is created once, using exclusive CREATE_NEW, only after both graceful exits and associated HTTP, database and listener-port checks pass.

The R14k Node analyzer requires exact schema/keys, four correctly ordered samples, two successful exits, restored room/chat and port release, positive process counters, and nondecreasing process CPU time within each launch. Extra keys are rejected to prevent accidental secret inclusion. It emits per-launch before/after resource deltas and has isolated self-tests covering valid and invalid input. No externally downloaded dependency is needed.

Windows package CI requires real EXE measurement, analyzer self-test and validated summary before the package artifact. A manual release uses the same pre-publish gate. Only ordinary CI uploads the sanitized JSON report and summary as a **separate 14-day artifact**; release does not add these measurements to public release files.

## Limits and field acceptance

- **Two short EXE lifecycles** cannot demonstrate leak freedom or a leak. JVM startup, GC and Windows page accounting affect numbers.
- A positive memory/handle/thread delta is descriptive, not a CI failure threshold. A negative/zero delta is not a pass for production stability.
- WebSocket 24-round samples in R14j remain **independent isolated-JVM data**. They must not be conflated with R14k packaged-process samples.
- The CI file-trigger for graceful exit follows the R14h documented CI-only path. No public control endpoint is introduced.
- Browser and WebSocket regression, R14i read-only real external HTTPS/WSS acceptance, manually clicking the Explorer tray menu, 24-hour EXE process load, multi-machine real-network tests, installer, signed distribution and rollback verification remain separate.

## How to review

Confirm both push and independent PR Windows CI for the same exact head commit, with all regression and E2E steps passed. Check for the R14h 19-check graceful shutdown marker, R14k self-test PASS and R14k validated report PASS; inspect the GameRoom-R14k-Packaged-EXE-Metrics CI artifact. The report and derived summary must be restricted to the allowlisted fields.

Example in PowerShell 7+ after building a Windows app image (both filenames must not exist):

    $report = Join-Path $env:TEMP "bgp-r14k-exe.json"
    $summary = Join-Path $env:TEMP "bgp-r14k-summary.json"
    ./server/smoke-packaged-game-room-restart.ps1 -StopMode Graceful -TelemetryPath $report
    node ./server/analyze-packaged-process-telemetry.mjs --self-test
    node ./server/analyze-packaged-process-telemetry.mjs "--input=$report" "--summary=$summary"

The report and summary paths are write-once, so create fresh names per run.
