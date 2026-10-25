# R13d — host-controlled synchronized telephone album reveal

**Stack:** draft PR on R13c #58, with all previous Drawing Guess R13a/b/c and GameRoom guest boundaries preserved.

## Gameplay and UX

After the final telephone/Co-op stage finishes, everyone may see the finished albums as in R13c, but only the **connected authenticated room host** controls the **shared** album/step cursor. The host sees previous/next album and stage buttons; other players and spectators see the selected frame with read-only disabled controls and an explicit synchronized-presentation message. Album changes reset to the first step. No UI relies on SOOP nicknames, authenticated broadcaster accounts, or presence of a platform login. Full-screen on reload/foreground uses the same standard existing GameRoom bearer.

Server `GET /api/v1/room-membership/drawing/telephone` returns `presentation: {albumIndex, stepIndex, revision}` **only in REVEAL**. Before reveal `presentation` is null; earlier albums remain hidden. Every participating browser requests this endpoint on normal 3-second GameRoom polling and immediately on foreground/online/pageshow. This is **eventual sync within the existing poll cycle**, not a low-latency WebSocket slideshow; fast animation, per-room broadcast events, and optional manual browsing/follow toggle are intentionally out of scope.

Host uses `POST /api/v1/room-membership/drawing/telephone/present` with `{albumIndex,stepIndex,expectedRevision}`. Existing same-origin POST, CSRF, authorization and guest token checks apply. A validated connected host can only mutate after the game has reached `REVEAL`, and coordinates are bounded by the frozen match roster. SQLite V43 stores `reveal_album`, `reveal_step`, `reveal_revision`, all defaulting to zero for prior completed matches. Updates are single-transaction and use an optimistic revision predicate to prevent stale tablet/browser commands from overriding newer host choices. Replaying an already applied exact destination is idempotent, with no increment. Only after the database write commits may all clients see the next cursor.

## Security and recovery

- Guest, spectator, disconnected/revoked host and client-supplied provider identifiers cannot drive slideshow.
- Non-host clients never write local album indices; every refresh replaces them with the server position.
- Existing stage/album content secrecy unchanged until REVEAL.
- A new/reloaded client restores the current cursor from the room's SQLite state, not from browser localStorage.
- V43 is registered in explicit schema migrations and the previous-version backup fixture is updated to drop presenter columns in reverse order.
- Normal-mode and Co-op-mode album data, R13c immutable drawing authority, match participants and scoring policy unchanged.

## Tests / acceptance

`GameRoomTelephonePresenterR13dProbe` verifies host-only cursor control, spectators follow, invalid album/stage, no premature reveal, identical replay, stale revision conflict, restart recovery and revoked session denial. Existing GameRoom HTTP probe adds origin/CSRF, read-only member, bounds, replay fencing tests. Browser Chrome and Edge run existing full three-player NORMAL and COOP telephone modes and verify that viewers receive the host's stage, preserve identity on reload, and follow subsequent album changes. All existing regression probes and Windows packaging remain CI gates.

**Deferred:** WebSocket push for subsecond synchronized reactions, synchronized motion/replay, presenter transfer, controlled autoplay, live SOOP broadcaster ownership/real account testing.
