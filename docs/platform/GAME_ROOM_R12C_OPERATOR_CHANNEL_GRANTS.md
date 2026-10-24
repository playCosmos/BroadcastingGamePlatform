# R12c — operator-attested, room-scoped broadcast channel grants

**Status:** R12c Draft on top of R12b #53. No account requirement for gameplay, no host approval on join, no cross-browser guest identity guesses, no release.

## Security flaw addressed

R12a allowed any connected anonymous GameRoom host to bind a SOOP `provider/channelId` label. Even if R12b had only administrator-configured SOOP connections, another room's host could claim one of those streams and forward its chat into the wrong game. Host membership alone is **not authority to use another broadcaster's chat**. This change makes authorization server-enforced and opt-in.

## Grant flow

1. The operator configures an authorized SOOP streamer ID in the server's existing `streamerId` or `soop.additionalStreamerIds`. The server does **not** accept a browser guest request to start an upstream SOOP connection.
2. A logged-in **server administrator** deliberately issues a one-time capability for a specific **GameRoom UUID + provider + channel ID** using `POST /api/v1/room-membership/admin/drawing/channel-grants` with `{roomId,provider,channelId,expiresInSeconds}` (TTL 60–3600 seconds). The normal same-origin and administrator-session checks apply. The response returns `grant`, `provider`, `channelId`, `roomId`, `expiresAt`; set `Cache-Control: no-store`. UI support for admin issuance can follow without changing this contract.
3. Administrator must verify source ownership/permission **out of band** before issuing. Grant issuance succeeds only when the SOOP source is explicitly configured and enabled, and the room is an eligible Drawing lobby/match. **This is operator attestation, not automated SOOP OAuth ownership proof.**
4. The guest room **host** supplies the grant in `POST /api/v1/room-membership/drawing/channels/add` with `{provider,channelId,grant}`. A spectator/player cannot use it. The server validates current member session and connected host role, configured stream, matching room, channel, provider, TTL and unused token, then **consumes and installs the authorized binding in one SQLite transaction**. Other rooms, stale tokens, altered names and replay are rejected. Existing authorized binding retry remains idempotent; removing and re-adding requires a fresh grant.
5. Grant is 32 bytes CSPRNG, base64url-encoded 43-character bearer; **only SHA-256 digest** is stored. The grant value never appears in public room snapshots or channel listings. Channel lists contain approved labels only. Data is isolated by per-room membership authentication.
6. V39 drops old unauthorized V38 label rows during upgrade (otherwise a malicious room could squat on a configured channel). The new `authorized_at` field is nullable for data safety: routing requires non-null, so direct legacy insertions are invisible to users and cannot score. A valid grant may atomically approve such an existing label. Closed rooms still release channel bindings in the existing closure transaction.
7. Score processing is unchanged: the platform's trusted SOOP event bus and existing native Drawing Judge run only for approved channel matches. General room chat remains separate, and `GAMECENTER` provider cannot be bound as an external source.

## Explicit trust boundary

- Guest registration/login is **never** required for hosting, joining, guessing or spectating.
- This scheme does **not** prove the guest is the streamer. The administrator must confirm stream ownership/permission by an external workflow before issuing a grant. Never label it OAuth verification or automatic streamer authentication.
- Source validation uses operator-configured streamer IDs; the SOOP SDK's emitted `channelId/bid` identity mapping must be checked in live staging before relying on real multi-source coverage.
- The administrator endpoint must remain behind local/admin-session controls, not a public guest endpoint.
- Fully automated broadcaster ownership verification, grant revocation/audit UI, and operator-facing grant issuance UI remain follow-up work.

## Acceptance

New R12c probe verifies forbidden host/spectator operations, unprovisioned sources, wrong room, single-use hash and replay, expiration, SQLite reopen, migration fail-closed behavior, previously unverified channel rejection, and post-room-close lease release. Existing R12a probe now uses room-scoped grants instead of bypassing new authorization, and real Chrome/Edge HTTPS/WSS E2E requires guest hosts to fail when attempting unapproved binding. Full JavaScript/PowerShell checks, regressions, E2E and Windows packaging are required on exact PR head.
