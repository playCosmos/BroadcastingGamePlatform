# R14c — Cross-game room lifecycle acceptance

Parent: R14b Draft PR #84 (verified SHA `ba4cd81a3549118d60a88ba8f884bc95abb84341`).

## Goal

Exercise the complete anonymous common-room lifecycle in real Chrome/Edge browsers against the production GameRoom API for **both Drawing and Yacht**. The earlier R13/R14 suites tested individual session and response races; R14c checks that the end-to-end guest policy, total room capacity, chat, revocation and public listing continue to work after those changes.

## Browser acceptance matrix

| Step | Drawing | Yacht | Observable acceptance |
|---|---|---|---|
| Create hosted public room | anonymous Drawing host | anonymous Yacht host | six-character room code and bearer |
| Join as spectator | Drawing public form | Yacht public form | separate bearer, `SPECTATOR` role; total 2 members, only 1 player |
| Host-only controls | hidden for spectator | hidden for spectator | host/ready restrictions in DOM; raw spectator kick API yields 403 |
| Room chat | host to guest and guest to host | same | actual messages appear in opposite browser, not just HTTP response |
| Reload / reconnect | reload page, foreground event | same | original member token, room name and chat replay restored |
| Kick | host calls authenticated API | same | guest returns to admission; kicked bearer 403; chat and private invite cleared |
| New identity | same guest browser joins with a *new* token | same | allowed as a fresh anonymous spectator, not resurrection of kicked member |
| Voluntary leave | guest leave action | same | guest bearer becomes 403 and host roster excludes departed guest |
| Close room | host close action | same | host bearer revoked, removed from directory, new join request rejected |

## Policy boundaries

- An account is **never required** to create/join/play/spectate. Registered accounts are reserved for optional profile, nickname, achievements and records, not game privileges.
- Maximum room membership includes host + players + spectators; player cap is independently enforced. This acceptance suite uses maxPlayers=2, maxRoomMembers=3, with the host counting as the only player and guest as spectator.
- Revoking/kicking a bearer terminates **that member session**. A new anonymous identity may join an otherwise available public room according to existing server admission rules; this test does not introduce a new ban policy, browser fingerprint or host approval gate.
- The backend is authoritative: DOM hiding is not sufficient without a raw API unauthorized check.
- Browser refresh preserves the valid sessionStorage bearer; revoked token cannot be reused after reload. Guest chat is a general room channel, distinct from Drawing guessing.

## Current coverage versus release-readiness gaps

**Automated, deterministic scope:** Windows-hosted Java fixture; real Chromium and Edge under NORMAL+COOP Drawing suites, dynamic HTTP+WSS, multi-tab independent browser contexts, public admission/close/kick, spectator and guest chat, reconnect, responsive 390px viewport, and Windows x64 packaged build checks.

**Requires separate field or operational acceptance:** multi-device/mobile cross-network latency and unstable WAN connections; reverse-proxy deployments with real production TLS, CDN/load balancer and WSS reconnect; SOOP/other streaming providers with authorized real channels and chat loads; long-running rooms with hundreds of spectators and rate limits; packaged Windows UI startup/installer on clean physical machines; accessibility and manual UI usability; resource leak/heap/uptime soak; Windows Defender/SmartScreen and release signing.

R14c is limited to regression coverage and focused defects actually revealed by tests. No new shared runtime, database/schema, API or permission changes; existing stacked Draft chain remains unmerged and unreleased.