# GameRoom R10 — browser WebSocket recovery and replay acceptance

Draft follow-up to R9 TLS/mobile test PR #49. No new account requirement, approval queue, dependency or permission change.

## Goal

Treat interruptions as network failures, never as a new identity. Reestablish existing token-authenticated subscriptions without replay gaps or duplicated user-facing chat messages. Keep the kick/revocation 1008 policy: authorized reconnect succeeds; revoked reconnect fails.

## Real browser test scenarios

The existing headless Chrome/Edge two-context E2E, migrated SQLite service, production Drawing/Yacht HTML/JS and actual loopback HTTPS + WSS proxy remain unchanged. R10 records active proxy-upgraded sockets and forcibly destroys browser/upstream TCP connections **without WebSocket close frames** to simulate unexpected Wi-Fi loss (typically WebSocket close code 1006).

1. Start Drawing Guess round using a mobile-touch host, then draw a line over HTTPS and verify ink on a distinct spectator's Canvas over WSS.
2. Close both active Canvas WSS upgrades *from the reverse proxy* rather than invoking browser JS `WebSocket.close`. Verify new WSS upgrades establish automatically, previously drawn Canvas data is restored from the server's canonical stored history, and member bearer tokens do not change.
3. Reload the spectator's real browser document with cache bypass, ensure the new document commits, and verify Canvas replay reconstructs pixels from SQLite. The same tab-scoped token is retained; no new seat is allocated.
4. Close the authenticated member-room WSS upgrades without close frames. Post a durable room chat message from the host during the outage, then confirm the spectator's UI reconciles exactly one visible message and the client reopens a member WSS connection.
5. Validate the **server replay cursor contract** with a fresh authenticated observer: `afterSequence=seq-1` replays the missed chat exactly once, while `afterSequence=seq` returns no duplicate chat (room.snapshot is still expected). Anonymous credentials are never passed in a query string.
6. Finally kick the spectator. A connected authenticated member-room WSS must close with **1008**, and subsequent HTTP requests with the old token must fail; this is **not** treated as a recoverable network interruption.

## Deliberate constraints

The R10 change is primarily end-to-end acceptance code. Game clients already have delayed re-subscription on close and authoritative HTTP polling. Changing the retry scheduling implementation is not justified unless the new real-browser tests expose an actual defect.

This is local Windows-runner simulated network loss, not an actual flaky LAN/router/cellular handoff. Physical Android/iOS browsers, external CA-trusted staging TLS, browser background-tab timer throttling and multiple app-server deployment remain future verification gates. No merges/releases.
