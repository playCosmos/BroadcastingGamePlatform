# R6 foundation — anonymous public room hosting and direct admission

Status: Draft. Layered on PR #45. This milestone adds public admission without host approvals or an account requirement. It does not merge or replace the private invitation API.

## Product contract

- Guest and registered users **must have identical game, room-owner, spectator, chat, kick and invite permissions**. Profile/achievements/permanent statistics are optional account features, developed separately.
- **Public** game rooms are immediately joinable without an account or individual host approval. The user chooses PLAYER or SPECTATOR, constrained only by room state and capacities.
- Existing administrator-created rooms are **private/invite-only by default** and are absent from the public directory. Their legacy `/hosted` and `/join` endpoints remain unchanged.
- Neither IP address nor new browser session proves the user's persistent identity. A kicked member's old token is blocked, but a new anonymous identity joining a public room is permitted. Rate-limits reduce abuse; they do not promise permanent human bans.

## Public REST endpoints

All endpoints live under `/api/v1/room-membership`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/public/hosted` | Guest creates a PUBLIC room; server issues host session credential |
| GET | `/public/rooms?gameId=drawing_guess` | At most 30 recent open/playing public rooms, safe summary without member IDs |
| POST | `/public/join` | Enter selected public room by game + 6-character room code + selected PLAYER/SPECTATOR seat |
| POST | `/hosted` | Existing **admin-only** and invite-only creation, unchanged |
| POST | `/join` | Existing invitation-only join, unchanged |

Public create body: `{"gameId":"drawing_guess","name":"Room","displayName":"Guest","hostSeat":"PLAYER","maxPlayers":6,"maxRoomMembers":20}`.

Public join body: `{"gameId":"drawing_guess","roomCode":"ABCDEF","displayName":"Guest","seatRole":"PLAYER"}`, where the actual code is issued by the server and excludes ambiguous letters.

HTTP writes still require a trusted same-origin browser request. Every visitor receives an independent, random, 256-bit room member bearer stored server-side only as a hash. Browser room session tokens remain tab-scoped.

## Persistence, atomicity and limits

- V36 adds an opt-in `game_room_public` table; previous administrator/invite-only rooms are **not** retroactively made public.
- New public creation, room visibility marker and host session are created together in a BEGIN IMMEDIATE transaction.
- Joining reads current visibility, state, unique player count and total member count and issues a member token in one transaction. Mid-game PLAYER admission is forbidden; SPECTATOR admission is allowed while total space remains.
- Guest public creation: 3 attempts per 10 minutes per remote address; public direct joins: 30 attempts per 10 minutes per remote address (bounded 4,096 in-memory rate windows). This is **abuse throttling**, not identity-based banning; deployments behind multiple reverse proxies or multiple server nodes need shared limits.
- Maximum concurrently OPEN_LOBBY/PLAYING public rooms is 128. Public lists return at most 30. These ceilings are operational protections, not game-specific room capacity rules.

## Drawing Guess client

`/games/drawing-guess/room/` now allows guest creation, browser listing, room-code join with selected PLAYER/SPECTATOR role, and retains invitation token admission. Public listing names render through `textContent`, not HTML insertion. Shared Canvas member authentication and immediate kicks remain from PR #45.

## Acceptance and known follow-ons

The Windows CI path runs the new **real network** `GameRoomPublicAdmissionProbe`, existing R1–R5 contract/service/HTTP/WS/legacy probes, JavaScript static client probe, and package verification. The new probe covers private room isolation, no-admin hosting, same-origin enforcement, typed joining, role-specific capacity, kick/rejoin semantics, creation rate limit and SQLite persistence.

Remaining before release: actual browser DOM flows on supported devices, mobile drawing, external HTTPS/WSS through deployment proxy, and a capacity/load review of the chosen IP-based operational limits. Optional accounts/profile/achievements and R6 multi-streamer fan aggregation are separate milestones.
