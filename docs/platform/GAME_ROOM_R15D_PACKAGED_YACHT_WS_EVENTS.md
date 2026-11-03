# R15d — actual packaged Yacht event WebSocket fanout and bounded recovery

Parent: fully Windows CI-verified R15c Draft PR #111, exact head `61a1374e98bc4207c277cfcc3d83dc22d9f531a6`.

## Purpose

R15c verified that twenty authenticated room-member WebSockets stayed connected through a complete six-player / fourteen-spectator Yacht match and received durable **chat** events. That does **not** verify Yacht dice/score notifications: the client also subscribes to a separate `?yachtCode=...` WebSocket channel. The native Y2 game layer commits roll/score events with immutable versions to SQLite and emits best-effort WebSocket notifications; the existing `/api/v1/games/yacht/public/{code}/events?since=N` endpoint is its event replay fallback.

## Real packaged Windows acceptance

This optional R15d stage reuses the same real second Windows packaged EXE JVM, R15c's twenty authenticated member connections, R15b's six-player / fourteen-spectator room, and its **78 authoritative Yacht scoring turns**, with no new room, listener, or production protocol.

1. Open four additional **actual Yacht notification WebSockets**, with twenty R15c room-member sockets already open: **24 connections from the same loopback IP**, exactly the existing server cap. Do not increase the 24/IP connection bound.
2. Verify two committed events per turn: `yacht.dice.rolled` and `yacht.score.committed`; each event must have the correct room scope, immutable increasing sequence/version, match completed-turn count, and correct order. Three Yacht sockets remain subscribed through all 156 events each.
3. The fourth socket observes the first 16 turns (32 events), disconnects cleanly, misses five further turns (10 events), obtains those ten events from the **actual durable Yacht HTTP event history** and reconnects for turns 22–78 (114 more live events). Validate the reconstructed 156-event stream exactly against the authoritative HTTP command results and verify all socket close codes.
4. The same 20 authenticated member room connections remain live for the whole match and complete their R15c chat fanout and reconnect tests. The existing rejected spectator/non-active commands and duplicate final command must not create any additional Yacht events.
5. Emit only a fixed-count, non-identifying JSON report, verify its exact shape with a negative-case offline analyzer, retain the uploaded evidence artifact for fourteen days, and gate both the Windows packaging workflow and any explicitly initiated release workflow.

R15d expected markers:

- `GAME_ROOM_R15D_PACKAGED_YACHT_EVENTS_PASSED players=6 sockets=24 yacht=4 live=614 replay=10 turns=78`
- `GAME_ROOM_R15D_PACKAGED_YACHT_EVENTS_VALID players=6 sockets=24 yacht=4 live=614 replay=10 turns=78`

## Boundaries

Four native Yacht event WebSockets plus twenty *different member-room WebSockets* are simultaneous; this is **not** twenty Yacht event sockets at once, nor 24 full Chrome browser tabs, multi-host/WAN, mobile field acceptance or production delivery. The replay uses the already-existing bounded public Yacht event-history endpoint; it does not claim that Yacht WebSocket connections themselves replay events. All room IDs, tokens, codes, actual dice, player names and event bodies are intentionally absent from published evidence. No production code, API, security limit, or schema changes. Draft, unmerged and unreleased pending independent exact-head Windows Push + PR CI verification.
