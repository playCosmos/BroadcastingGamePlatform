# R13a — multi-streamer drawer roster (first R13 vertical slice)

**Stack:** R12d Draft PR #55. **Status:** implemented, exact-head Windows CI required. No merge, release, TTS changes or host-approved room admission.

## R13a goal

Drawing Guess can already rotate the drawing authority across a frozen list of **actual joined PLAYER members**. This increment connects operator-approved SOOP chat sources from R12c/R12d to a room host's streamer/player assignments, and freezes only those members as the authoritative drawing roster when a match starts. It deliberately **does not trust SOOP chat user IDs as game-room session credentials** and does not issue anonymous remote drawing privileges.

## Flow

1. Server operator configures multiple SOOP streams (R12b), confirms streamer consent out-of-band, and issues one-use room/channel grants (R12c/d). The guest host redeems grants as before. Users continue joining without registration or approval; host/player/spectator counts remain independent.
2. While the room is **OPEN_LOBBY**, the authenticated **connected host** calls `POST /api/v1/room-membership/drawing/streamers/assign` with `{provider,channelId,memberId}` to associate an **approved bound channel** with an actual connected PLAYER in that room. An empty member ID clears the assignment. The request never accepts a provider user ID as a trusted drawing identity. `GET /drawing/streamers` exposes assignments to the room host only.
3. The host chooses **다중 스트리머 순환 출제** in the Drawing Guess UI. This maps to native `ROTATING_DRAWER` plus boolean `streamerRotation:true`, preserving legacy policies and SQL CHECK constraints. `POST /drawing/start` remains backwards compatible: absent `streamerRotation` means false.
4. Start validates at least **two distinct selected connected PLAYERs**, checks that all assigned channels are approved, and stores `streamer_rotation=1` in the match reservation plus the immutable ordered roster in `game_room_drawing_drawer_roster` within the **same SQLite transaction** that moves the common room to PLAYING. Player order is the room's frozen player order, not a mutable provider event order.
5. Native room participants still include all actual PLAYERs, but only selected streamer PLAYERs have `can_draw=true`. The existing `DrawingGuessGameService.drawerForRound`, `GameRoomDrawingService.expectedDrawer`, `myPrompt`, `draw` and drawing session/Canvas authority implement deterministic per-round turns and reject all non-drawers. Ordinary non-streamer players can still guess and score; spectators remain spectators. No second scoring engine or client-selected round owner.
6. Once PLAYING, channel-to-member assignment changes fail and a retry with a different rotation mode/config fails. Losing a websocket or disconnecting a selected streamer does **not** silently reassign their turn; reconnection of their **original game-room credential** recovers their existing turn. Channel revocation stops incoming chat scoring but does not retroactively rewrite the frozen native drawer roster.

## Persistence and boundaries

- V40 adds nullable `drawer_member_id` to approved broadcast binding, a boolean `streamer_rotation` to the existing Drawing link, and a separate ordered immutable roster. All are migrated by the explicit `BoardGameDatabase` list with an updated pre-migration backup probe.
- R13a does **not** automatically verify that the assigned GameRoom member owns the SOOP account. R12c's operator grant is *room-channel* permission, not a member identity proof. The room host chooses player assignments. For fully authenticated streamer identity, later integrate the provider's verified owner with a GameRoom session claim; never substitute a chat nickname.
- The roster freezes drawing **round order**; it does not implement mid-round collaborative Canvas handoff or "continue drawing". Canvas per-round event history, token/grace handling and stale socket guards remain from R5/R11. Those are separate **R13b** changes.
- Native game creation after a crash during the rare reservation→native creation boundary still relies on existing R5 recovery semantics; exercise forced termination during this window before considering real multi-broadcaster production rollout.
- Real multi-account SOOP network staging, matching SDK `channelId/bid` and operator verified broadcast consent are still not established by offline tests.

## Acceptance matrix

`GameRoomStreamerRotationR13aProbe`: cross-room/spectator/non-host assignment rejection, approved-channel requirement, two assigned streamers among three real PLAYERs, native `canDraw` filter, immutable order and retry, non-drawer prompt and Canvas denial, provider-channel removal not altering committed order, original credential reconnection, SQLite restart and full match finish. Run together with all R1–R12d regressions, Windows server compile, Chrome/Edge HTTPS/WSS GameRoom E2E and Windows packaging at exact PR head.
