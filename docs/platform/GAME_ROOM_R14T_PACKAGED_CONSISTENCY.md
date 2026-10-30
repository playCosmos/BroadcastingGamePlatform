# R14t — Actual packaged chat idempotency, delayed cursor and Yacht stale-command consistency

**Parent:** verified R14s Draft PR #101 (head `09dfec75828c04edccc863bd1e1f626d6253131b`). R14t remains a separate stacked Draft; no merge, release, schema migration or production code modifications.

## Purpose

R14s established actual Windows packaged EXE gameplay with two authenticated player WebSocket sessions, reconnect and four scored Yacht turns after one real packaged JVM restart. R14t extends the **same isolated Windows packaged listener-JVM fixture** to challenge existing server idempotency and authorization boundaries. No test endpoint is public; everything uses disposable localhost accounts and SQLite.

The two existing game players and their room remain in memory in the PowerShell harness. R14t starts its own bounded local Node 22+ worker **after R14s** in each packaged process lifetime. No credentials are passed on command lines or written to final artifacts.

## Tests performed per real packaged JVM lifetime

1. Authenticate two distinct original PLAYER members and subscribe two real room WebSockets. Verify both snapshots match the same room with exactly two players.
2. Commit a host chat using a stable message ID. Verify one live message with the same committed sequence reaches each subscriber.
3. Retry **the identical message ID with exactly the same payload**. Require its returned sequence to be unchanged and that no duplicate event appears on either socket. Allow a short local delivery window before counting; the durable HTTP event record supplies the final exact-once assertion.
4. Retry that ID with **different text**. Require HTTP 409 and no additional durable chat record.
5. Request previous and later event cursors; require exactly one matching durable event at the older cursor and none beyond the consumed cursor. Require the stored chat message to exist exactly once. A third player-authenticated socket subscribed **from the already consumed cursor** must not receive the old message again. Close all three sockets cleanly.

Only on **the second packaged process lifetime**, when R14s has advanced the original authoritative Yacht match to five completed turns and the guest is active:

1. Commit a sixth-turn **guest dice roll** under the current match version. Verify the same Yacht match ID, version advance and dice count.
2. Retry with the **same command ID and expected version**. Require identical dice and version without a second roll.
3. Try the same ID with a different expected version, and a new command ID using a **stale previous version**. Both must return HTTP 409.
4. Have the **non-active host** attempt a roll. Require HTTP 403.
5. Read the authoritative Yacht match again and verify no rejected/duplicate request changed the committed version, dice or completed turn.

The test does not simulate randomly reordered WAN packets or client-side JavaScript network interception. It verifies **specific delayed event-cursor boundaries and duplicate/stale HTTP requests** against an actual running packaged JVM.

## CI, privacy and limits

Both Windows packaging and manual release workflows run the actual extended packaged fixture and then validate a new sanitized R14t report with `server/analyze-packaged-yacht-consistency.mjs`. Its synthetic self-tests reject incomplete, altered and secret-bearing records. The artifact retains only successful verification flags, counts and bounded durations—**no bearer tokens, room/member identifiers, IP addresses, listener ports, chat body, dice values or process IDs**. Final report is written with CreateNew semantics only after the second real JVM closes gracefully and all three listeners are released.

The existing R14n 12-spectator WebSocket test, R14r genuine two-player game restart and R14s player socket/multi-turn acceptance remain independent prerequisites. A green R14t run proves neither 24-hour operation nor remote public HTTPS/WSS availability, multi-PC participation, actual WAN packet reordering, installer signing, tray UI, upgrade/rollback or absence of resource leaks.

To reproduce on Windows with PowerShell 7, build the real packaged app first, then choose **seven distinct nonexisting report paths** and run:

    ./server/smoke-packaged-game-room-restart.ps1 -StopMode Graceful -TelemetryPath $r14k -LoadRounds 24 -LoadReportPath $r14l -WsSpectators 12 -WsReportPath $r14m -WsSoakCycles 6 -WsSoakReportPath $r14n -YachtReportPath $r14r -YachtWsReportPath $r14s -ConsistencyReportPath $r14t
    node ./server/analyze-packaged-yacht-consistency.mjs --self-test
    node ./server/analyze-packaged-yacht-consistency.mjs "--input=$r14t" "--summary=$newSummary"

All seven reports must be in an operator-controlled disposable test directory; no production account or room may be supplied.
