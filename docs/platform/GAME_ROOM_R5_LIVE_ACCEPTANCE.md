# Drawing Guess R5 — live transport acceptance

Status: **automated loopback transport gate**, stacked on R5 reconciliation PR #43. Not a release or actual WAN/TLS/manual device certification.

## Why

The R5 static browser contract (111 checks) and HTTP adapter probe (26 checks) pass, but do not jointly prove Canvas events are sent to multiple live WebSocket connections, replayed after reconnection, or isolated from authenticated room chat. This gate starts the actual platform public HTTP server and real WebSocket server against a temporary migrated SQLite database.

## Coverage / acceptance contract

1. HTTP serves **the repository's real** `/games/drawing-guess/room/` HTML and browser script, not synthetic templates.
2. Three room members (host PLAYER, second PLAYER, one SPECTATOR) consume **three total** seats but **two actual player** seats.
3. Two authenticated member room WS subscriptions deliver room snapshots and later the same chat event.
4. Rotating game starts only after both players ready; the native round answer and private drawer bearer are omitted from public data.
5. Deliberately recovered native drawer bearer is **rejected with WS 1008** for any common-room round.
6. Two simultaneous **read-only** drawing WebSockets receive the exact same committed, sequential Canvas clear / begin / point batch / end events from authenticated HTTP writes; unauthorized spectator HTTP write returns 403.
7. Third socket reconnects and replays sequences 1–4 in order; attempting a client-side direct drawing WS write closes with 1008.
8. Ordinary room chat containing the answer does **not** score guesses; authenticated SPECTATOR submits the same word through the separate guess endpoint and succeeds; current drawer may not score their own answer.
9. During a round, host kicks SPECTATOR: REST state/guess/chat are denied, prior member WebSocket closes upon next event, remaining members can keep chatting.
10. Windows CI builds the server, runs the new probe with R1–R5/Yacht/legacy regressions, verifies package and uploads artifact.

## What this does **not** prove

- Chrome/Edge/Firefox/Safari real DOM interactions, mobile multitouch/latency/visual appearance, reconnect UX in browser JavaScript, and accessibility.
- Public reverse proxy **WSS/TLS**, multi-node WebSocket fanout, remote WAN/packet loss/latency.
- The drawing-code read-only overlay socket is deliberately **not member-authenticated**, so removal from a room revokes the authenticated member REST/channel but does not revoke a previously known broadcast drawing code. Requiring private viewer-only stream access would be a separate product/security design change.
- Collaborative/relay drawing and R6 multiple streamers are distinct milestones.

## Local/CI entry points

After building server with Maven from `server/`, run `./run-regression-probes.ps1` from PowerShell or the single Java main class `io.github.playcosmos.broadcastinggameplatform.boardserver.GameRoomDrawingR5TransportProbe` with `target/test-classes;target/classes;target/probe-dependencies/*` as the Java classpath on Windows. The test starts ephemeral loopback servers, uses a temporary SQLite database, and always releases sockets, servers, and files in `finally`.

Retain sibling PRs #41/#42 and #43; merge/release only after planned human UX and WSS gates.
