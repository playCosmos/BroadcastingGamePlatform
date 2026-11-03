# R15h — two-room authenticated WebSocket isolation at 24 connections per IP

Parent: CI-verified R15g Draft PR #115, exact head `639110fae27086071844be7b467019694137c043`.

## Motivation

R15g proved one Yacht room with 20 independent real Chrome/Edge browser sessions, but did not prove that simultaneous rooms cannot see one another's room chat or native Yacht events; nor did it exercise the existing 24-connection-per-IP upper bound and capacity reclamation after kicking a live spectator.

## Scope and acceptance

Extends the already mandatory `server/game-room-browser-e2e.mjs` Windows browser acceptance suite on the same disposable Java HTTP/WebSocket/SQLite fixture. It runs immediately after the existing R15g 78-turn/20-browser acceptance, **while all 20 authenticated room A member WebSockets remain connected**.

1. Create separate public Yacht room B from a different isolated browser context. Admit exactly two B players and two B spectators through the production UI, for **24 actual authenticated browser WebSockets on one loopback address**, distributed over two different room IDs (20+4). All sockets must remain open.
2. Open one extra unprivileged browser WebSocket to a valid room-ID endpoint. It **must** be rejected with close code `1013` and no frames, while none of the existing 24 member sockets are disconnected. No server cap increase.
3. Commit chat in A; require all 20 A subscribers to receive the matching event and none in B. Commit chat in B; require all four B subscribers to receive it and none in A. Observations inspect only event type and message ID, not bearer secrets or message text.
4. Start a genuine two-player Yacht game in room B through normal ready/start controls. Commit a real native roll and score. All four B member WebSockets must receive the two correct events, while all twenty A browsers must keep their original 156 native events (no B events leaked across room boundary).
5. Kick a B spectator during the active game. The kicked browser WebSocket must close with code `1008` and its original membership bearer must be rejected with 403.
6. A *new*, distinct B spectator browser joins the still-running match using the real public admission UI and must successfully reuse the freed 24th connection slot. The replaced member and all A members must not receive a new B chat event; B's remaining users and replacement must receive it.
7. Navigate B browser contexts away to shut down all temporary B connections, preserving the main R15g room's 20 browsers. All existing R15a/g and R15b–e suites must remain green.

Expected marker:

`GAME_ROOM_R15H_BROWSER_CROSS_ROOM_BOUNDARY_PASSED rooms=2 browserSockets=24 capRejected=1013 chatIsolation=both yachtIsolation=both kick=1008 recycled=1`

This is a **test-only change**. It uses one Chrome/Edge process with isolated browser contexts over one localhost IP. It does not represent separate physical hosts, NAT gateways or production WAN, and does not modify the product's connection quotas, auth design, runtime server code or release behavior. Keep Draft, unmerged and unreleased pending exact-head Windows Push and PR validation.
