# R13e — near-instant telephone album reveal through existing room WebSocket

**Stack:** R13e Draft PR on R13d #60, preserving all R13a–d behaviour and the no-login GameRoom model.

## Server event path

The room host continues to call the R13d authenticated same-origin `POST /api/v1/room-membership/drawing/telephone/present`, guarded by an expected revision and backed by the V43 SQLite canonical album/step cursor. **Only after this presenter transaction commits** does the HTTP handler ask the existing `GameRoomRealtimeService` to announce that exact revision. A separate short room writer transaction:

1. authenticates the **connected host** again;
2. reads the canonical `game_room_telephone_match` row in `REVEAL` state, rejecting mismatched/stale revision requests;
3. avoids replaying an already emitted `telephone-reveal-<revision>` event;
4. allocates the next durable room `event_sequence`, stores an `Event` in the existing `game_room_event` log, and commits; and
5. broadcasts an ordinary **`room.telephone.presentation`** event on the preexisting authenticated member-room WebSocket after commit.

The event has the room ID, monotonic room event sequence, revision-tagged message ID, and text containing **only** public `albumIndex,stepIndex,revision`. Never broadcast in-progress prompt or inherited private canvas data. No additional WebSocket server, library or migration. A failed notification does not undo the completed presenter command: REST snapshots remain the source of truth and a later retry can repair a missed event. Existing room event replay survives socket interruptions and process restarts. A duplicate presenter command must not consume another room event sequence.

## Browser

Drawing Guess already subscribes with a per-tab authenticated GameRoom bearer to `?memberRoomId=...` and handles chat events. R13e handles `room.telephone.presentation` on that same socket. The event is a **wake-up hint**, not another drawing state authority: after parsing a valid revision, the client reads `GET /drawing/telephone`, verifies it still belongs to the same room and token, rejects older GET results, and renders the SQLite-backed presentation. It never sends a presenter action for spectators. In flight older messages and reconnect replay cannot rewind the UI. The normal 3-second room poll, online/foreground handling, and authoritative `presentation` snapshot continue to cover disconnected clients.

This provides near-instant handoff under healthy networks but makes no hard subsecond SLA; network delay, busy browsers, and HTTP latency still apply. WebSocket audio announcements, presenter transfer, real multi-SOOP account attestation and autoplay are independent features.

## Tests

- `GameRoomTelephoneLiveRevealR13eProbe`: no event before reveal, host authorization, spectator/ordinary player rejection, correct non-sensitive revision cue, post-commit publish, identical retry dedupe, stale revision suppression, monotonic event order, durable `/events` replay and revoked session checks.
- Existing Drawing HTTP probe now verifies HTTP commit creates a replayable room WebSocket event and idempotent retries do not create duplicates.
- Client contract probe verifies room WebSocket handler and authoritative REST reconciliation.
- Full Chrome/Edge real-browser NORMAL + COOP E2E adds authenticated spectator WebSocket observer and observes the host's live event before proceeding with follower synchronization/reload.
- Windows full regressions and packaged artifact still gate the exact PR head.

**Known trade-off:** Event-log insertion is a second transaction after the presentation cursor commits; a crash between commits can lose push but **not** canonical room state. Polling and later snapshot recovery are required by design.
