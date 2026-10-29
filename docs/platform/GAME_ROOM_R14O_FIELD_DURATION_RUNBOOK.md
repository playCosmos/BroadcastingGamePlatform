# R14o — Real Windows 24-hour JVM observation (field runbook)

Parent: R14n Draft PR #96 at CI-verified SHA 0d31d0e863698697bc918e7b8efcfb3b46cfa0f3. R14o is stacked Draft only, not merged or released. No new runtime dependency, production endpoint or database migration.

## Purpose and security boundary

R14n proved roughly 59 and 62 seconds of authentic WebSocket spectator churn in a real Windows app-image, but is not long-duration evidence. R14o provides an **opt-in, read-only local Windows process observer** and a strict offline field report analyzer. Do not leave GitHub Actions running overnight. The observer **never** creates, starts, stops, restarts or changes a service, account, room, token, database, configuration or game state.

The collector checks that the three configured local listening TCP ports have exactly the same owner, that executable is within the intended installed/extracted Windows app-image, and that process has a loaded jvm.dll. Each sample checks the same owner PID **and original process start time**, so even PID reuse/restart is rejected. If any check fails, or if the operator interrupts a run, its JSONL report has no completion footer and the analyzer must reject it.

The only report data are schema-v1 markers, observed UTC times, elapsed duration, numeric JVM working-set/private bytes, thread/handle counts and CPU time, expected sample interval/count, and completion attestations. The output deliberately omits process IDs, port numbers, hostnames, addresses, user IDs, room codes, bearer credentials, command lines, chat and application logs. UTC timestamps and resource counters remain sensitive internal diagnostics and should be stored securely, never committed to GitHub.

## Requirements

- Actual Windows packaged server already running normally and a local PowerShell 7+ session with rights to query its process modules, CIM process metadata and listening ports.
- Node 22+ for analyzing the completed report.
- The app-image directory containing BroadcastingGamePlatformServer.exe (not the repository root).
- All **three effective local listening ports**: admin HTTP, WebSocket and public/client HTTP. Confirm them from the running server configuration. Example port numbers below are placeholders, NOT actual defaults.
- A new (nonexisting) JSONL file path in an operator-controlled, restricted folder.

## Full field observation

Run on the **same PC** as the already-running packaged Windows server. Substitute all paths and ports below; the server is not launched by the observer.

    $app = 'C:\GameCenter\BroadcastingGamePlatformServer'
    $report = 'D:\GameRoomField\r14o-field.jsonl'
    ./server/observe-packaged-jvm-field.ps1 -AppRoot $app -ListenerPorts @(15710,15711,15712) -OutputPath $report -DurationSeconds 86400 -IntervalSeconds 60

After the full 24 hours, analyze the completed **local** JSONL file; the summary target must also be new:

    node ./server/analyze-packaged-jvm-field.mjs --self-test
    node ./server/analyze-packaged-jvm-field.mjs "--input=$report" "--summary=D:\GameRoomField\r14o-summary.json"

Default analysis rejects observations shorter than 86,400 seconds. A success requires a complete exact-length sequence of samples with valid provenance, strictly ordered monotonic elapsed timestamps/CPU, sensible resource counters, no excessive missing sample windows and a completion footer for the same JVM. It reports first/last/min/peak, per-hour observed resource changes and hourly peaks. **It does not assess leak freedom** or guarantee service uptime.

For a **one-minute smoke only**, use different fresh paths and override the analyzer minimum explicitly:

    ./server/observe-packaged-jvm-field.ps1 -AppRoot $app -ListenerPorts @(15710,15711,15712) -OutputPath 'D:\GameRoomField\smoke.jsonl' -DurationSeconds 60 -IntervalSeconds 10
    node ./server/analyze-packaged-jvm-field.mjs "--input=D:\GameRoomField\smoke.jsonl" "--summary=D:\GameRoomField\smoke-summary.json" --min-duration-seconds=60

A short smoke success does **not** count as completing a 24-hour run. Output paths cannot preexist; partially recorded data are retained for diagnosis and **must not** be interpreted as completed acceptance.

## Concurrent users and TLS/WSS are separate checks

The process observer only samples counters; it deliberately does not generate chat, reconnects or spectator sessions. Concurrently, from an **external machine**, you may run the existing R14i read-only HTTPS/WSS test against a separately approved and disposable test room. It strictly validates public TLS hostname/chain and requires a temporary member bearer via the BGP_WSS_PROBE_TOKEN environment variable (never CLI or URL). Use the instructions for server/smoke-external-game-room-wss.mjs and the related R14i documentation. The room UUID is a command-line argument, so use a disposable test room and do not paste actual identifiers into support tickets.

For true 24-hour multi-machine reliability acceptance, separately record the Windows server version, OS, client counts, sustained realistic user traffic, authenticated chat/WS reconnect checks, network/proxy certificates and any user-facing outages in a restricted test log. Also separately test Windows tray clicks, deliberate shutdown/restart, installer signing, upgrades and rollback. **This collector intentionally does not restart a live service.**

## CI and evidence

The Windows package and manual release workflows parse the PowerShell observer and run the Node analyzer's synthetic full/short/mutated/partial JSONL fixtures. Hosted CI **does not run a 24-hour field observation** and does not upload operator field reports. A passing synthetic validator test means the field acceptance tool is operational, NOT that a production 24-hour burn-in has been completed.

GC, JIT warmup, native allocations, heap retention, and OS working-set paging all affect observed counters. Memory growth alone is not proof of a leak; an increase followed by GC or a plateau also needs human interpretation. The report is descriptive and requires comparison with actual live traffic conditions.
