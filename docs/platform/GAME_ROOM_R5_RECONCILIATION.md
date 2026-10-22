# GameRoom R5 reconciliation — PR #41 vs #42

Status: **implementation in Draft; no merge, release, or tag**. Parent is PR #42 (`df1b96b`), ultimately stacked on R4 #40. PR #41 (`54a691f`) remains an independent, CI-green comparison baseline.

## Source audit / resolution

| Concern | PR #41 | PR #42 / unified decision |
| --- | --- | --- |
| Drawer authority | Rotating PLAYER (2–20) | Retain #42: ROTATING_DRAWER and host-owned STREAMER_DRAWER |
| Common-room admission | Member bearer, distinct player/member limits | Retain R1/R2: all occupants count once in `maxRoomMembers`; only PLAYER in `maxPlayers` |
| Spectator answers | Rejects spectator guesses | Retain #42: authenticated SPECTATOR guesses via separate dedicated API (not room chat); no canvas write |
| Game bootstrap | Native game after lobby lock can strand unlinked DRAFT | Retain #42 deterministic `source_room_id` recovery and frozen lobby reservation |
| Drawing transport | Browser passes native `drawerToken` in WS URL | **Do not port**: #42 requires live member HTTP ACL per write; legacy token-write sockets restricted to legacy broadcaster rooms |
| Drawing replay | Read-only drawing WS history | Retain #42 subscribe-only WebSocket + authenticated write HTTP |
| UI path | `/games/drawing-guess/play.html` | Canonical `/games/drawing-guess/room/` (no second incompatible player entry) |
| UI coverage | 58-check static `play-probe.js` | Port intent into a new `room/room-probe.js` using #42 IDs, routes, privacy rules and CI wiring |
| Canvas UX | Clear tool, pointer sampling batch, canvas status | Port compatible controls, preserve #42 member HTTP writes |
| Starter retry UX | No staged-reservation metadata | Show frozen configuration on resumed/recovering lobby and replay it on retry |
| Regessions | R5 HTTP 2 rounds and JS DOM contract | Preserve #42 R5 37 service/26 HTTP, R1–R4, legacy Drawing D2, Windows package |

## Contract

- One canonical member gameplay URL. Legacy `/games/drawing-guess/` overlay and administrator broadcaster controls remain separate and unchanged.
- A client never receives the native `drawerToken`; `source_room_id` common-room canvases cannot obtain direct WS write authority. Each Canvas POST authenticates the member and current drawer.
- `/drawing/guess` scores authenticated room participants (PLAYER and SPECTATOR except current drawer), with room chat explicitly excluded.
- After a crash following lobby reservation, expose immutable mode/rounds/duration in member state to let the host retry safely without guessing initial form defaults.
- The UI must gate drawing controls by `canDraw`; the server always makes the final authorization decision. Invalid/expired credentials never fall back to administrator permissions.
- Native Drawing participant order is authoritative once the match starts. The R2 access layer currently forbids active PLAYER kicks/leaves/seat changes; preserve that rule, and calculate future drawers from the persisted native participant order rather than a potentially changing membership view. No forfeiture/skipping policy is implied.
- No schema/migration rewrites, no merging competing `V35` migrations; #42's V35 and `source_room_id` storage are authoritative.

## Acceptance gates

1. Canonical HTML/JS/CSS static-contract probe and JS syntax run in Windows CI; Windows package includes canonical assets.
2. Current HEAD Maven, legacy Board/Drawing, R1/R2/R3, Yacht R4, Drawing R5 HTTP and member ACL regressions pass.
3. Cross-room, revoked/kicked credential, prompt secrecy, spectator guess, and native-token WebSocket-write denial retained.
4. Real multi-browser/touch/WSS visual QA is a **separate manual acceptance gate**; CI alone does not certify it.
5. Keep #41 and #42 Draft/unmerged as provenance until this stacked reconciliation is reviewed. No automatic removal of old branches or release.
