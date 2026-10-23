# GameRoom R7 — public-room lifecycle and idle expiry

Draft, stacked on R6 public admission PR #46. All account and guest participants use identical room-management permissions. This milestone does **not** introduce approvals, logins, or player-seat restrictions.

## Owner close

- `POST /api/v1/room-membership/host/close` accepts an empty JSON object and the **current room host** R2 member bearer. Same-origin POST guard remains mandatory.
- Allowed only in `OPEN_LOBBY` or `POST_GAME`. Reject `PLAYING` with HTTP 409 so a running Yacht/Drawing match cannot be accidentally discarded.
- Under one SQLite BEGIN IMMEDIATE transaction, set common room state to `CLOSED`, mark occupied members `LEFT`, revoke **all** session hashes and unused invites and bump room version. Native match/history/score records are not erased. Public directory queries immediately stop showing the room.
- After commit, notify the existing membership transport listener for **every** member, closing subscribed room and shared Canvas WebSockets. A new invitation or old room code cannot reopen a closed room. Private rooms may also be explicitly closed by their host.
- Both Yacht and Drawing Guess clients expose `방 닫기` only for the host outside `PLAYING`. After success they clear tab-scoped bearer and close current sockets. Ordinary participant leave behavior is preserved.

## Automatic public idle expiry

- New V37 migration adds `game_room_public.last_active_at`, initialized to existing public room creation time, separate from room version/change timestamp. Administrator-created private rooms have **no public activity record** and are **never** automatically expired by this R7 process.
- A valid JOINED member polling common Drawing/Yacht game state (or `/me`) updates the activity timestamp **at most once per minute**. Fast polls perform reads without BEGIN IMMEDIATE; the conditional update then rechecks the token under a writer lock.
- Meaningful GameRoom writes also refresh the timestamp (room creation, join, ready, kickoff, native game completion POST_GAME transition, host transfer, kick).
- `OPEN_LOBBY` idle for **more than 90 minutes**: expire. `POST_GAME` idle for **more than 30 minutes**: expire. `PLAYING` is **never expired**, irrespective of client disconnect or duration.
- A daemon scheduler on the platform public HTTP server checks expiry every **5 minutes** while the server is running, in batches of up to 128 stale rooms, and is stopped on server shutdown. Listing alone does not extend room lifetime. R6's 128-active-public-room limit is therefore reclaimed even when the host never manually closes their room.
- Closure and a racing heartbeat serialize within SQLite transactions; closure cannot be undone by a delayed heartbeat. Expiry performs the same token/credential revocation and after-commit socket disconnection as explicit close.

## Security and remaining limitations

- Browser-local kick notices are advisory only; changing a browser creates a new anonymous identity and may permit a *new* session to join another still-open room. Account users get no privileged enforcement.
- Activity is member-authenticated, not IP-based. Stale-client write attempts and host close during PLAYING remain denied.
- R7 does not delete historical game/chat tables. A currently playing match whose client disappears indefinitely **remains protected**; a later match-abandonment feature must explicitly define how to end those matches safely.
- 90m/30m and five-minute scheduling are initial operational defaults, not externally configured policy yet. On multiple public HTTP nodes, every node may run cleanup but SQLite BEGIN IMMEDIATE serializes local DB access; multi-node/shared-database deployment is not covered.
- Final QA still requires Chrome/Safari/Firefox real client flows, mobile touch UX, and reverse-proxy HTTPS/WSS.

## Acceptance

Automated `GameRoomPublicLifecycleProbe`: clock-controlled SQLite migration, host-only closure, old bearer+invite refusal, fresh anonymous code refusal, private-room protection, liveness after heartbeat/meaningful changes, 90m/30m idle deadlines, PLAYING exemption, post-commit subscriber notifications. The live HTTP `GameRoomPublicAdmissionProbe` extends coverage to endpoint method/origin/host authorization and status projections. Existing R1–R6, Drawing/Yacht, Windows package and DB backup tests remain gates.
