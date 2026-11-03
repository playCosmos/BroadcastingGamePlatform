# R14j — Disposable WebSocket soak telemetry and pre-release review

**Parent:** R14i Draft PR #91, exact verified SHA `808842cfc969eb961e37f40d15e300e1e778ebce`. R14j remains a stacked Draft PR, with no merge or release.

## What changed

The existing R14g real WebSocket endurance test still runs Drawing Guess and Yacht against a disposable Java WebSocket listener and SQLite. With optional `--report=<new-file>.jsonl`, it now writes a **non-secret**, flush-per-round measurement stream: a schema-1 start record, one sample per completed round, and a completion record only after successful socket shutdown and TCP port release. Report creation uses `CREATE_NEW` to protect existing files.

Each sample records elapsed round duration, JVM heap used/committed, non-heap used, live and peak Java thread count, cumulative GC count/time and currently connected WebSocket count. It includes **no bearer tokens, room IDs, IP addresses, chat, player data or admin credentials**. These are **isolated Java acceptance fixture** observations; they are not process measurements for the packaged production EXE.

`server/analyze-game-room-soak.mjs` checks strict JSONL schema/order, exactly one sample per round, 12 connected spectators in each completed round, nondecreasing cumulative GC counts, valid heap/thread accounting, a successful completion marker and TCP listener release. On success, it writes a compact summary JSON with round-time p50/p95/max; heap first/last, min/max, slope and first/second-half averages; live thread range and slope; and GC increments. The analyzer has seven in-memory self-test assertions, including rejection of duplicated rounds, socket-count changes, corrupt GC counters, missing release, and unsupported schema.

The 24-round package and manual release workflows write this JSONL report to the CI runner's temporary folder and require the analyzer to pass before Windows distribution. Package CI also uploads the sanitized raw samples and summary as a separate, 14-day retained artifact. The release workflow checks the metrics but **does not publish a separate raw telemetry asset**.

## Interpreting the results

| Signal | What it establishes | What it does not establish |
|---|---|---|
| All 24 rounds and 12 sockets | Bounded local event delivery/acknowledged cursor and resource sampling completed | Hundreds of distinct-IP clients or WAN throughput |
| Heap first/last and slope | Observed allocation pattern in this short-running JVM | A leak; Java warmup and GC can dominate |
| Live thread count and peak | Bounded fixture thread behavior at sampled points | Native handle leaks, system-wide worker count or all threads between samples |
| GC count/time | Garbage collector work during the timed rounds | Application pause cause or SLA compliance |
| Round p50/p95/max | Local fixture durations for this CI runner | Internet latency, user QoE or long-term performance regression |

**Failure gates are semantic only:** truncated/out-of-order/missing data, unexpected socket counts, invalid JVM metrics, absent graceful listener release or earlier functional test failure. The analyzer does **not** mark increases in memory/thread counts as pass/fail because it lacks a controlled GC baseline and a meaningful release benchmark.

## Manual / field acceptance before merging for a release

1. **Actual desktop and tray:** On an interactive Windows workstation, launch the app image with an isolated root, create a room, click tray ‘종료’, confirm disappearance and process exit; relaunch and verify room/chat. R14h CI only triggers the same callback without clicking Explorer UI.
2. **Real HTTPS/WSS domain:** Use the R14i read-only operator CLI with a temporary spectator token over the intended external hostname/CA and reverse proxy. Inspect any dropped connections and latency series. Do not log or check in the bearer.
3. **Multi-client soak:** Provision multiple hosts/IPs and run a documented, bounded, extended load. Account for current per-IP WebSocket caps and request rate limiting; do not bypass production anti-abuse controls.
4. **Server resource monitoring:** Collect process working set, handles, threads, CPU, network/socket count, database size and system memory over a long run on a stable Windows host. Compare warm baseline versus same-load post-soak and repeat after restart; analyze GC cycles and any sustained slope.
5. **Release package:** Review third-party notices, version metadata, installer/signed distribution where required, new installations, upgrades and rollback on representative Windows systems. Check final commit lineage and run release gates **only** from authorized main/release branches.

## Running locally

From the server folder after Maven has built test classes and dependencies:

```powershell
$cp = @('target/test-classes','target/classes','target/probe-dependencies/*') -join [IO.Path]::PathSeparator
java -cp $cp io.github.playcosmos.broadcastinggameplatform.boardserver.GameRoomWebSocketEnduranceR14gProbe --rounds=24 '--report=./r14j-test.jsonl'
node ./analyze-game-room-soak.mjs --self-test
node ./analyze-game-room-soak.mjs --input=./r14j-test.jsonl --summary=./r14j-summary.json --min-rounds=24
```

Both output paths must be **new** (the scripts refuse overwriting existing results). Keep the report outside the repository for recurring runs. No external service or production data is required.