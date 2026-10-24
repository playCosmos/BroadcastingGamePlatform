# GameRoom R12a — explicit multi-channel broadcast-guess routing

**Status:** Draft implementation. Stacked on R11 PR #51; no base branch merge, production release, new account requirement or host admission approval.

## Goal and boundaries

Route chat **already received by trusted broadcast providers** from up to eight provider/channel bindings into one active shared Drawing Guess round, using the existing `DrawingGuessGameService` scoring and `GuessJudge` rather than inventing a second score engine. This is the first vertical slice of the originally requested multi-streamer/mixed mode. It does **not** establish new SOOP streamer connections or grant an unverified browser permission to subscribe to arbitrary platform streams. The server must already be receiving a channel via its configured provider.

## Behavior

- V38 `game_room_drawing_broadcast_binding` stores `(room_id,provider,channel_id)` per common room; the provider/channel pair is globally unique, preventing one incoming feed being assigned to two shared rooms. A database trigger frees all bindings on host close or idle expiration, avoiding permanently leased channels. Max 8 channels per room; membership host-only writes, connected status required, OPEN_LOBBY or PLAYING only.
- Public room members may inspect only their own room's channel labels through `GET /api/v1/room-membership/drawing/channels`. The connected host may add/remove via same-origin authenticated POST `/drawing/channels/add` and `/drawing/channels/remove`. Body is exactly `{provider,channelId}`. Inputs are bounded; provider `GAMECENTER` is reserved for authenticated member guesses. Idempotent same-room rebind is allowed.
- Native Drawing Guess chat routing now also matches **explicit common-room broadcast bindings** only when both common room and native Drawing match are PLAYING/ACTIVE. All incoming events still travel the existing platform event bus → `DrawingGuessGameService.processChatMessage` → native round judge. Non-bound channels never reach the room. Existing legacy streamer wildcard/exact channel logic and GAMECENTER member guesses remain intact.
- If a legacy room and common room would both accept a provider/channel, the current engine returns `AMBIGUOUS_ROOM_BINDING` and awards **no points**, rather than silently broadcasting a guess to multiple games. Admin operations for legacy binding still require later coordination UX.
- The same provider + user ID maps to one native participant across multiple channels. A user can score at most once per round even after cross-channel duplicate delivery or repeated guesses. Independent platform accounts cannot automatically be identified as the same person. Chat events timestamped before round start are rejected as `STALE_EVENT` to prevent delayed/buffered messages from scoring future prompts.
- These bindings are *not* general room chat, and the answer/aliases remain in private drawer-only APIs. No viewer-generated direct REST API pretends to be a SOOP message. The upstream event is millisecond-precision: round start comparison uses epoch milliseconds to avoid false rejection within a single millisecond.

## Test matrix

`GameRoomBroadcastR12Probe` covers guest-host ACL, spectator view, invalid and reserved provider rejection, channel uniqueness across rooms, max eight, idempotent retry, two-channel same-round scoring, duplicate viewer suppression, unbound channel rejection, pre-round replay rejection, disconnect/finish isolation, remove while playing and SQLite restart persistence. Registered in Windows PowerShell regression gate alongside existing R1–R11 suites. Public host UI exposes channel labels and host-only bind/unbind, with actual HTTPS browser E2E checking host form submission, spectator readonly listing and hidden controls.

## Not yet implemented — next R12b/R13

1. **Provider multiplexing**: current SOOP provider configuration starts one connection. Registering another channel does not cause the provider to connect to it; add explicitly provisioned per-streamer provider supervisors/config, bounded connection budgets, stream ownership/consent mechanism and channel-health display before promising arbitrary multiple live broadcasts.
2. **Multi-streamer drawer rotation**: R12a retains STREAMER_DRAWER host-fixed and ROTATING_DRAWER actual joined players. R13 needs explicit authorized streamer-to-member mapping and immutable per-round rotation, without accepting forged chat user IDs as host authority.
3. **Event identity improvements**: the existing provider payload has no standardized event ID; correct scoring is idempotent per provider user/round, but distinct accounts or duplicate wrong messages cannot be perfectly deduplicated. Extend the provider-neutral envelope when trustworthy upstream event IDs exist.
4. **Integration acceptance**: at least two real SOOP sessions, real simultaneous viewers and production CA-signed WSS external staging remain unverified. Browser testing covers the game-room UI but does not synthesize an actual SOOP provider connection.

## Design invariants

- Anonymous hosts, guests, spectators and registered users retain identical gameplay access.
- No host approval queue, new external dependency or exposure of room/member secrets.
- An invalid/banned member token never gains channel write authority.
- Start with an isolated stacked Draft PR; require exact-head Windows CI before claiming R12a validated.
