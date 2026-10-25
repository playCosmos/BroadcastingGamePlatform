# R13d — synchronized host album presentation

**Stack:** R13c Draft PR #58, no merges or releases. R13d synchronizes the completed story album slideshow, preserving independent audience navigation and existing NORMAL/COOP authoring semantics.

## Operator flow

1. A 3–12 player NORMAL or COOP telephone match finishes and opens its albums for room members and spectators. **No presentation state or album data is exposed while a match is still PLAYING.**
2. The existing authenticated GameRoom host clicks **방장 발표 시작** in the reveal view. The server stores the selected `albumIndex` and `stepIndex`, marks the synchronized presentation as enabled and increments a monotonic `revision`. All indices are validated against the room's frozen player count.
3. Viewers default to **방장 발표 따라가기: 켜짐**. Periodic authorized room refresh loads the shared cursor and switches to the host-selected page. A viewer may disable following to browse locally without modifying the shared cursor or affecting other viewers, then re-enable to catch up.
4. When presentation is active, only the host's previous/next album and previous/next step controls update the shared cursor. The host may end the presentation at any point; local album navigation remains available to everyone.
5. A spectator, ordinary room player, unauthenticated user, stale session, or tab with an obsolete `revision` cannot modify shared presentation. A returning host or viewer recovers the same presentation state from SQLite after process restart. No new user account, join approval, or admin rights are necessary.

## API/DB/security

- V43 adds `presentation_enabled`, `presentation_album`, `presentation_step`, and `presentation_revision` to `game_room_telephone_match`, each defaulting to zero for earlier games. Migration and pre-upgrade backup fixture are registered with the explicit DB migration list.
- `POST /api/v1/room-membership/drawing/telephone/present` requires the **connected room host's member token**, same-origin request, and `{expectedRevision,enabled,albumIndex,stepIndex}`. A SQLite writer transaction enforces full REVEAL and GameRoom POST_GAME state, bounds, authorization and compare-and-set.
- `GET /api/v1/room-membership/drawing/telephone` includes `presentation` only during `REVEAL`. Existing members can read the synchronized cursor together with already-public album content. If no telephone match exists, or the match is in progress, this field is null/absent and private prompt isolation remains unchanged.
- Synchronization currently uses existing authorized room polling; it is **not real-time WS server broadcast**. The polling cadence determines how quickly other browsers update. Switching to WS-based push can be a later, isolated transport enhancement.
- No secondary scoring system, no changes to SOOP stream ownership grants, and no new mandatory external dependencies.

## Verification

- Dedicated Java R13d probe tests pre-reveal lock, host-only mutation, spectator/regular player read-only constraints, optimistic stale revision rejection, index bounds, toggling on/off, no gallery loss, SQLite restart.
- Full existing GameRoom and telephone regressions; Chrome/Edge real three-player NORMAL and COOP relay now also verify host-controlled cursor, audience follow/unfollow, and host stop. Windows server/package CI on exact PR SHA.

## Open gates

- Real multi-SOOP account login/ownership verification and staging integration are still independent.
- Optional future improvements: room-level broadcast events for low-latency push, host autoplay with pause, album annotations, exporting a confirmed album, dedicated projector view and mobile presentation accessibility.
