# R12d — operator channel grant management

**Stack:** R12c Draft PR #54. R12d adds the missing human-accessible operator workflow for scoped SOOP permissions without introducing registration, host approval, or new dependencies.

## What is implemented

- **Admin console:** `/admin/broadcast-channels/` linked from `/admin/` under broadcast providers. Enter a shared Drawing Guess room UUID, an already operator-configured SOOP streamer/channel ID, and a 5–60 minute expiration. The console issues a cryptographically random room-scoped token once, copies it to the clipboard on user action, and does not persist the secret in URL parameters, session/local storage, or rendered channel listings. It clears the visible secret on input changes and pagehide. Operators must pass it to the intended room host over a trusted channel. The anonymous Drawing Guess room UI exposes the needed room UUID **only to the room host**, with an explicit copy action; the public six-character join code remains separate.
- **State list:** authenticated `GET /api/v1/room-membership/admin/drawing/channel-grants?roomId=<UUID>` returns **non-secret metadata** `{channels:[{provider,channelId,status,changedAt}]}`: `PENDING` grants with expiry time and `BOUND` channels with authorization time. Expired or consumed grants are not listed. Secret and SHA-256 grant hash are never returned.
- **Issue:** existing admin-authenticated, same-origin `POST /api/v1/room-membership/admin/drawing/channel-grants` with `{roomId,provider,channelId,expiresInSeconds}` only permits explicitly provisioned SOOP sources. Newly hardened to reject duplicate **pending** grants for one room/channel, grants for already authorized channels, and more than **eight** unconsumed/unexpired grants per room. This validation and issue happen in one SQLite write transaction. A second issue requires explicit revocation of the pending grant, or expiration.
- **Revoke:** new admin-authenticated, same-origin POST `/api/v1/room-membership/admin/drawing/channel-grants/revoke` with `{roomId,provider,channelId}` removes all grants and any active broadcast binding for that specific room/channel in one SQLite transaction. It is safe to retry and stops further SOOP messages from entering that room via the authoritative judge. Existing already-awarded points are retained (no retroactive result tampering). A fresh grant is required to reconnect.
- **Permissions:** operator pages are UI only; **the server checks administrator session for every listing/issue/revoke**. Public anonymous members and even anonymous room hosts cannot invoke these operator APIs. The room host may redeem a valid token in their own room via existing R12c API; spectators cannot. CSRF/origin rules for POST remain active.
- **Scope:** still operator attestation; this is **not proof that the host owns the SOOP channel** and not SOOP OAuth. The operator must independently establish broadcaster consent and validate actual emitted SOOP `channelId/bid` against the approved streamer. Real multi-stream SOOP staging remains an acceptance requirement.

## Files and acceptance

- `GameRoomDrawingService` operator list, atomic revoke and transactional issuance constraints.
- `GameClientHttpServer` admin-only GET status + POST revoke while preserving existing issue.
- `web/admin/broadcast-channels/index.html` and `web/admin/assets/broadcast-channel-grants.js` as a standalone operator workflow; linked from existing admin home.
- `GameRoomBroadcastGrantR12dProbe` verifies pending and active listing, no secret exposure, quota, duplicate issue, revoke before consume, immediate scoring shutoff after revoke and persistence after SQLite reopen.
- `GameRoomDrawingR5HttpProbe` checks anonymous HTTP denial, origin protection, operator list privacy and authenticated revoke. Existing R1–R12c regressions and Chrome/Edge HTTPS/WSS E2E remain in the Windows CI.
- Keep R12d Draft (stacked PR) until exact-head Windows CI succeeds. No merge, release or automatic change to SOOP upstream connections.

## Future stage

R13: explicit authorized multi-streamer-to-GameRoom member mapping, deterministic drawer transfer and continuous/collaborative drawing. Independent real SOOP connectivity/consent checks remain necessary before public roll-out of broadcast scoring.
