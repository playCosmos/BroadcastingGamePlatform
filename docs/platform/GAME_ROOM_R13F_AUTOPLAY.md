# R13f — authoritative timed telephone album slideshow

**Stack:** R13f Draft PR over R13e #61; scoped to completed telephone NORMAL/COOP albums. No standalone game mode, new dependencies, release or merge.

## Interaction

- During REVEAL, the authenticated **room host** can select a slideshow interval (3, 5, 8, 12 or 20 seconds), begin/resume automatic album progression, and pause. The chosen speed and play/pause status are shared with every connected player and spectator. In the standard R13d manual mode, hosts still have next/previous album/step; these controls are intentionally disabled while autoplay is active.
- Autoplay steps through stage 1 → stage N within album 1, then the remaining albums. Reaching the final frame **stops** autoplay without wrapping; pressing Play on the final frame explicitly restarts at album 1, step 1. Pause freezes the most recently materialized frame; changing speed resets the countdown without jumping to a different frame.
- Viewer progress shows the host's chosen speed and seconds until the next frame. Only the host sees playback-control inputs. Spectators cannot mutate the cursor even with forged POSTs.

## Server clock and persistence

- V44 adds `reveal_playing`, `reveal_interval_seconds`, and optional `reveal_next_at` (absolute ISO UTC timestamp), all with defaults that keep R13d and older albums paused. The existing V43 `albumIndex,stepIndex,revision` remains the **only source of truth** for the visible slide.
- Host commands use `POST /api/v1/room-membership/drawing/telephone/playback` with `{action:PLAY|PAUSE|SPEED, intervalSeconds,expectedRevision}`. Existing room bearer + same-origin mutation, joined host checks, REVEAL-only state and revision fencing apply. Identical action retries do not change the revision.
- A **GET /drawing/telephone** (or a host playback command) compares the next due time against the **server clock** inside the SQLite writer transaction, materializing one or multiple missed slides in one atomic step, assigning a monotonic revision for each elapsed step, and advancing its stored next deadline. This design needs no daemon thread or browser-owned gallery state. If every browser disconnects, next reconnection deterministically catches up to the correct position and stops at the last slide. A pause command first reconciles elapsed time, then freezes the current frame.
- After a committed auto step, a connected room reader can cause the existing R13e durable **room.telephone.presentation** event to be emitted. Readers are permitted to request **only** a post-commit wake-up for the current revision, never mutate the gallery or forge arbitrary content. The existing room WebSocket and revision-fenced REST refresh update other clients. Events may be lost but canonical 3-second polling and reconnect recovery persist.
- The browser updates its second countdown locally, then requests an authoritative state read when the server deadline is reached. Other users' read requests can materialize the same timer; unique SQLite revision conditions prevent double ticks. Client time is only used as a wake-up hint and countdown, not as trusted progression authority.

## Trade-offs and boundaries

The playback is **server-time-derived, lazily materialized on authenticated reads**, not driven by a constantly running background scheduled process. A gallery with no connected clients has no need to broadcast intermediate frames; the first subsequent request immediately catches up. This avoids per-room scheduling threads and process shutdown complexity. The absolute clock source is the server machine; runtime OS clock changes affect deadlines until resynchronized. A truly global always-running scheduler and hard synchronized millisecond playback across internet browsers are not claimed.

## Verification

- New `GameRoomTelephoneAutoplayR13fProbe` checks pre-reveal/guest denial, interval bounds, identical retries, pause, paused speed changes, revision conflicts, multi-slide catch-up, SQLite process restart, natural final-frame stop and explicit replay from the end.
- Drawing HTTP integration tests cover POST ACL, same-origin, speed bounds, clock-triggered GET step, room event replay, pause and speed changes.
- Chrome/Edge 3-player NORMAL/COOP real browser acceptance exercises host speed and play/pause controls, spectator automatic slide, WebSocket notification, host manual-button lock, and reliable pause.
- V44 backup migration fixture, previous R1–R13e regressions and Windows packaging remain gates. No merge or release without explicit request.
