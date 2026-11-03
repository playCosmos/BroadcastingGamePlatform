# R14f — Real WebSocket spectator reconnection and transport shutdown

**Parent:** R14e Draft PR #87, exact validated head `969a63890d51d9541049953363d9c4658949bd8c`. R14f stays a stacked Draft PR. No merge, release, configuration change, or production-data access.

## Scope and evidence

`GameRoomWebSocketSoakR14fProbe` runs a production `BoardGameWebSocketServer` listener on an ephemeral **127.0.0.1** port, backed by actual disposable SQLite, member admission, bearer authorization, and `GameRoomRealtimeService` publication. No synthetic socket callbacks or mock transport are used.

Each game (`drawing_guess` and `yacht`) creates a public hosted room with 10 authenticated spectator identities, verifies that the player count is one while the member count is eleven, then connects ten real JDK WebSocket clients and checks their authenticated snapshots and reception of a durable first chat event.

The clients abruptly abort their sockets; the host commits another chat while they are offline. All ten re-subscribe with the old event cursor on new sockets, verify replay of the missed sequence, and receive a third live event without sequence duplication. Kick revokes the first spectator's active WS (`1008`), a fresh subscription using the revoked credential is rejected (`1008`), and closing the hosted room terminates remaining authorized spectator sockets. This is repeated for both game IDs.

Finally the test gracefully stops the real WebSocket server, then confirms its TCP listening port can be bound again. It records JVM heap-used and thread counts before/after as diagnostics, not as arbitrary CI pass/fail thresholds. It asserts observable socket delivery, revocation, cursor semantics, and listener cleanup.

### Limits acknowledged

The test deliberately uses ten spectators per room, well below the current **24 connections per remote address** policy. Across both games it makes fewer than the **120 handshakes per 10-second rate-window** limit. This avoids mislabeling intended anti-abuse throttling as a capacity defect. It is a bounded local socket acceptance, not a 24-hour soak, hundreds-of-users scalability, memory-leak proof, real-world WAN/HTTPS reverse proxy test, or a packaged Windows tray-click graceful exit test. Those remain separate release gates.

### Existing CI flake hardened

An R14e *non-final* push CI timed out waiting only **2 seconds** for an already-authorized Telephone WebSocket presentation event while the corresponding PR CI passed. R14f retains the same authoritative event assertion but gives the asynchronous browser/SQLite/WS notification a bounded **6 seconds**, consistent with the longer expected timings elsewhere in the real-browser acceptance suite. No production retry or authorization semantics changed.

## Automated gates

- New R14f Java transport probe included in platform regression checks.
- Existing R14e historical V28→V44 upgrade/restore, 48-spectator SQLite soak and real packaged EXE crash-restart remain mandatory.
- Drawing and Yacht client contracts, Chrome/Edge E2E, Windows package and workflow release safety checks remain mandatory.
- Exact final-head push and independent stacked PR Windows CI must pass before marking R14f validated.

## After R14f

Separate 24-hour external-network stress testing, production topology TLS/WSS, physical Windows tray/OS shutdown semantics, installer/signed release rehearsal, and load sizing under multiple remote IPs remain outstanding; do not classify this bounded local probe as complete field acceptance.