# GameCenter identity-neutral room and moderation policy (2026-10-23)

## Confirmed product rules

- Registration and login are **optional**. Guests may host, play, watch, chat, invite, and exercise host moderation under exactly the same rules as registered users. No login-specific gameplay limits or privileged moderation.
- Accounts provide optional persistent profile identity: saved nickname/profile, achievements, game statistics/history and preferences. Guests can earn the same achievements for the current session; server-verified guest progress may be linked to a newly registered account later.
- A room membership is **not** an account. Server-issued `memberId` and secret `sessionToken` are the sole authority for commands and authenticated channels. Client-provided player/account identifiers may not elevate privileges.
- Do **not** implement host approval as an entrance mechanism: hosts cannot reliably identify applicants. Target room entry modes are **open/direct entry (default)** and **invite-link/direct entry**, optionally password-based later. Login must not be a prerequisite for either.
- `maxPlayers` counts seated PLAYERs. `maxRoomMembers` counts distinct HOST/PLAYER/SPECTATOR members, not the number of external broadcast viewers.

## Kick, reconnect and browser reset

1. Committed host kick sets KICKED membership and revokes all existing member session tokens and member-issued invitations.
2. Existing member-room and common Drawing Canvas WebSocket channels close on a server-side revocation event. All subsequent REST and WS subscriptions use fresh server-side token+JOINED membership checks.
3. The room browser stores a *local revoked-session notice* for UX, stops polling with the invalid token and discards session credentials. This notice can be cleared and is never trusted by the server as a security check.
4. Cache clearing, private browsing and switching browser/device can create a new anonymous identity. **Do not claim to recognize or permanently ban that same person.** IP address alone must not be treated as identity. Request/chat/game command rate limits may slow abuse; they cannot solve anonymous human re-identification.
5. Current `game_room_ban` entries block the **known actor ID / existing member identity**, not magically all replacement browser identities. Avoid UI copy that promises otherwise.
6. Current R2 hosted HTTP bootstrap is **administrator authorized** and membership join uses issued invitations. Full unrestricted public room discovery/direct admission is a separate pending common-room feature; this document establishes that product requirement, **not** a claim it is implemented. Do not add approval queues or account-only entry while implementing public admission.

## R5 Canvas protocol

- Shared `drawingCode` maps persistently to `drawing_guess_room.source_room_id`. Server must resolve this itself; client-provided room IDs are untrusted.
- Browser opens `?drawingCode=<code>` with **no token in URL**, then sends first WS frame `{"type":"drawing.subscribe","token":"<member-session-token>"}`.
- No replay or live event until the subscriber is authenticated and JOINED in the exact source GameRoom.
- All later Canvas WebSocket frames are read-only; HTTP Canvas mutations independently authorize the active drawer. Member kick/leave/disconnect/revoke closes current WS sessions; subsequent subscription or replay is denied.
- A legacy broadcaster Drawing room with no `source_room_id` retains its existing public overlay and streamer drawer-token authorization. Never apply the shared-room member requirement to that legacy channel.

## Acceptance

Automated: R5 Java real HTTP/WS multi-member probe, Java R1-R5/legacy regressions, static JS contract and Windows packaging CI. Pending manual gates: actual Chrome/Firefox/Safari/mobile touch interaction, reverse-proxy HTTPS/WSS and external deployment. R6 multi-streamer design follows R5 acceptance.
