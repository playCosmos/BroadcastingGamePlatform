# R14g — WebSocket restart endurance and resource observations

**Parent:** R14f Draft PR #88, exact validated head `e3b22ada37679af19942c640ad7cc63d64b1c0ba`. R14g remains a stacked **Draft PR**, with no merge, release, production data access or new public endpoint.

## Actual test path

`GameRoomWebSocketEnduranceR14gProbe` uses the real `BoardGameWebSocketServer`, `GameRoomAccessService`, `GameRoomRealtimeService`, durable SQLite and the JDK HTTP WebSocket client against loopback. It covers both `drawing_guess` and `yacht` in a single transport process.

1. Each game room has one player-host and six anonymous spectator memberships. Twelve real WebSocket listeners are authenticated through the existing `room.subscribe` protocol and verify member counts, player counts and live chat sequence 1.
2. All clients abruptly disconnect. The WebSocket server is **gracefully stopped**, its listener port is verified reusable, and the SQLite database is reopened through new service instances without clearing credentials or event history.
3. A second event is committed while transport is down. A new WebSocket listener starts on the same port; all 12 spectators reconnect using original bearer credentials and cursor 1 and must receive the exact missed sequence 2.
4. Six CI rounds (configurable via `--rounds=N`) send one live event per game, abruptly abort every subscriber, commit a different event with no subscribers, and reconnect with the prior cursor. Each new socket receives the exact missed sequence; no duplicate cursor is accepted as progress.
5. Verify all room event sequences remain monotonic, kick one member per game (WS close 1008), close the room (remaining WS close 1008), stop the second listener and prove port reuse again.

The probe emits JVM thread count, used-heap bytes, connected socket count, elapsed time and a round counter. Those are diagnostic observations, not a memory-leak certification or arbitrary timing pass/fail threshold. Each connection is paced at ~145 ms to stay below the production handshake rate limit, and only 12 sockets are live at once (production localhost cap: 24).

## Running longer locally

From the `server` directory after Maven has built the probe test classes and copied dependencies, use the same classpath as `run-regression-probes.ps1` and invoke `io.github.playcosmos.broadcastinggameplatform.boardserver.GameRoomWebSocketEnduranceR14gProbe --rounds=200`. The CI default is six rounds, and the probe accepts 2–10,000 rounds. Prolonged runs may create many disposable SQLite chat events and generate significant disk/CPU usage; run them on a disposable machine, not a live server.

## Remaining acceptance work

- These are **local process/component restart tests**, not Windows tray-menu graceful shutdown, host OS shutdown, user-profile installer or code-signing validation. R14e already verifies that the real packaged Windows EXE recovers from a forced stop, not that the tray path shuts down cleanly.
- HTTPS/WSS over a simulated TLS proxy is exercised by the existing Chrome/Edge browser suite. Real external TLS termination, load-balancer timeouts, WAN latency, proxy client-IP headers and multiple household IPs require a separately provisioned environment.
- CI runs a bounded six-round test, not a continuously monitored 24-hour endurance test. Metrics across independent CI runners cannot establish a leak trend. A manual long-duration soak requires clear baseline, host telemetry, threshold, and final report.
- Existing room capacity/anonymous guest policy remains unchanged; no browser fingerprint, forced account, host approval or bypass of per-remote WebSocket connection limits is introduced.

## R14g browser CI stability investigation

During parallel independent Windows CI runs, the first R14g PR build completed the new Java transport probes but the pre-existing **TLS proxy WSS authenticated snapshot** acceptance timed out at its original 15-second limit. The matching push CI completed that same test successfully. This is not sufficient to classify the issue as an application authorization defect. The acceptance remains mandatory; its wait is now bounded at 25 seconds and a failure records only non-secret observer state (readyState, close code, event count and upgrade count) to distinguish delayed handshakes from rejected credentials. No production WebSocket behavior is modified.

## Validation gates

- New R14g probe passes in the same regression suite as R14f transport (93), R14e migration (47) and R14e spectator (270).
- Prior Drawing (507), Yacht (95), Chrome/Edge E2E (555) and real Windows packaged EXE crash-restart (9) checks remain mandatory.
- Separate push and PR Windows CI both conclude success at the exact R14g head before completion can be reported.