# R15e — Single authenticated Yacht member WebSocket and 20-member native game fanout

Parent: CI-verified R15d Draft PR #112, commit `f2c9b8eecb9ef255cac7de6a9cb5b86316036c36`.

## Confirmed production risk

Before this change, `web/games/yacht/yacht.js` opened both `?memberRoomId=` (authenticated common room) and `?yachtCode=` (legacy public game) sockets per browser tab. The server caps same remote address at **24 WebSockets**, so twenty room members behind one NAT would attempt **40 sockets** and some real-time sessions would be rejected, falling back to the 3-second polling backstop. R15d's 20+4 test validated a bounded mixture of distinct clients, not twenty real Yacht browser tabs.

## Scope and implementation

1. Preserve the native Yacht-by-code WebSocket and existing `yacht_event` SQLite event history/REST replay for older consumers. Do not weaken total connections, IP quotas, or public lookup limits.
2. When a native Yacht event commits, `PlatformServerMain` resolves its **already persisted common-room Yacht binding** via `game_room_yacht_link` and calls the existing authenticated `broadcastRoomEvent(roomId, json)` on the same WebSocket server. That service verifies every subscriber's current credentials and joined room membership before sending. Events for standalone/legacy Yacht rooms never get sent to unrelated members.
3. The member Yacht browser client keeps exactly **one authenticated memberRoomId WebSocket**; both `room.*` and `yacht.*` messages trigger the appropriate HTTP refresh. The redundant public game socket is not opened. The 3-second polling fallback remains when the socket cannot connect.
4. Native Yacht game event sequence/version is **not** the same as room chat event sequence; only `room.*` events may update `lastMemberSequence` so chat replay after reconnect cannot skip missed messages.
5. The existing R15b/c/d actual packaged Windows fixture is opt-in extended by `-MemberYachtReportPath`: keep 20 different authenticated member-room WebSockets and four legacy native Yacht event sockets (24/IP) while playing six players and fourteen spectators through 78 scoring turns. Each member socket must receive **both** committed Yacht events for every turn with the exact authoritative version, phase and completed-turn count — 20 × 156 = **3,120 verified native game notifications**. Existing R15c chat delivery/replay and R15d native Yacht fanout/replay checks must also remain green.
6. The evidence file contains counts and invariants only; a strict negative-case analyzer rejects missing, altered or unexpected fields. Windows packaging and explicitly initiated release workflows enforce the check and retain the report for 14 days.

Expected markers:
- `GAME_ROOM_R15E_PACKAGED_MEMBER_YACHT_WS_PASSED players=6 members=20 sockets=24 gameEvents=156 delivered=3120`
- `GAME_ROOM_R15E_PACKAGED_MEMBER_YACHT_WS_VALID players=6 members=20 gameEvents=156 delivered=3120 sockets=24`

## Limits

Packaged Windows localhost, same one JVM and database, not 20 automated full Chrome instances, remote/WAN networking, real NAT ingress, mobile browsers or production endurance. The authentication boundary is server-enforced; browser event notifications are hints and the HTTP game state remains authoritative. Existing standalone Yacht-by-code clients remain compatible. No merges, tags, publishing or deployment are part of this Draft PR.
