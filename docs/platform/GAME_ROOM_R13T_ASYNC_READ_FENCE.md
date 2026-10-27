# R13t — Fence stale auxiliary authenticated reads

**Base:** Verified R13s Draft PR #75, commit `ab350018fc72de2c6eb7ce19481d9d048710902e`. The previous milestone fenced the main `/drawing` and `/drawing/telephone` GET pair and late 403 after room switching; this milestone covers the asynchronous **follow-up reads** that can still mutate the wrong room UI.

## Observed risks
- `refreshChat()` currently awaits a `GET /chat?after=-1` and then replaces chat DOM with no membership recheck. A room A WebSocket wake can finish after joining room B, overwriting B's chat view.
- `refreshChannels()` and `refreshStreamerAssignments()` use the mutable bearer and current global snapshot across one/two awaited responses. An old host's channel/assignment GET can populate a newly accepted host's controls and leak room A's labels to the wrong UI.
- `syncTelephoneReveal()` validates ownership only *after* an unpinned request; `socketConnections()` awaits WebSocket config without rechecking member identity and `refresh()` reuses global reads after awaits.

## Implementation contract
- Every auxiliary authenticated GET captures the membership generation and exact bearer once at entry (or receives that pair from `refresh()`), submits with that bearer, and performs a generation/token guard before any DOM or shared-state mutation. A two-request streamers refresh checks between requests and before rendering. Drop stale results silently, including stale failures.
- Make an old WSS reveal cue's telephone read explicitly credential-bound. Recheck after asynchronous WebSocket configuration resolution so old sessions cannot bind old sockets into a newly accepted room.
- When switching membership, immediately clear room-specific displayed chat/channel/streamer lists and their options in addition to existing snapshots (without clearing the new token). Do not create new server endpoints, storage formats, browser-wide state, permissions or external packages.
- Keep current live kick/revocation behavior and existing guest/host/spectator rules; old responses never invalidate a fresh session.
- Keep the guard localized rather than introducing another service abstraction or unnecessary files.

## Acceptance
- Static tests verify pinned token and generation guards for chat, channel and streamer reads, including the between-GET barrier; WebSocket reveal pinning and configuration barrier.
- Chrome/Edge multi-member NORMAL+COOP acceptance holds an old room's chat read (triggered by a genuine room chat WSS message) while switching the same browser to a different hosted room, then releases old response and verifies B's chat list has no A data and the new token/room is intact. Preserve the earlier delayed old-member 403 test.
- Run the entire R1–R13s platform regression suite, real browser acceptance, Windows x64 package verification and artifact upload on the final exact head. Keep the stacked pull request **Draft**, no merge or release.
