# R15c — twenty concurrent authenticated room WebSockets on packaged Windows EXE

Parent: fully Windows-CI-verified R15b Draft PR #110, exact parent commit 4d81464f850ad6c75af2aed803ab4df343cd0a9b. R15b already completed a six-player, fourteen-spectator, 78-turn Yacht match against the shipped Windows EXE, but only established final HTTP views for all 20 members.

## New actual packaged WebSocket acceptance

R15c extends the **same second Windows packaged EXE JVM** and the **same R15b room**, avoiding an additional room-creation or public-admission quota. It opts in via -TwentyWsReportPath, requiring -SixPlayerReportPath and the existing full graceful-restart fixture.

1. Six PLAYER and fourteen SPECTATOR identities are admitted through the existing real host-issued bounded invitations, with no changes to public abuse limits.
2. All twenty distinct member bearer sessions independently connect to the actual packaged WebSocket port with the real memberRoomId channel and perform authenticated room.subscribe. All 20 member snapshot frames must report precisely 6 players and 20 room members.
3. Host sends an actual stored room chat event through HTTP. All 20 open sockets must receive the same committed sequence, not merely prove a successful handshake.
4. The same twenty connections stay open throughout **all 78 real authoritative Yacht score turns**. The host sends a second real chat event; all twenty subscribers receive it, yielding 40 verified live deliveries.
5. All sockets must close with actual normal WS close code 1000/1001. One spectator reconnects using its last-seen sequence and must recover the second message from persisted cursor replay.
6. The test writes a sanitized, exact-shape JSON evidence file and a strict offline analyzer verifies counts and rejects unauthorized fields/negative contract cases.

Expected markers:

- GAME_ROOM_R15C_PACKAGED_TWENTY_MEMBER_WS_PASSED players=6 spectators=14 sockets=20 live=40 replay=1 turns=78
- GAME_ROOM_R15C_PACKAGED_TWENTY_MEMBER_WS_VALID players=6 spectators=14 sockets=20 live=40 replay=1 turns=78

## Limits

Node's native WebSocket talks to the real packaged EXE over disposable loopback. This **does not** represent public WAN, multi-host broadcaster traffic, 20 visible Chrome UI tabs, streaming-platform authentication, or long-duration production performance. It deliberately stays inside the existing 24 simultaneous WebSocket connections/IP, 120 handshakes/10 seconds, and 30 public joins/10 minutes limits. All live credentials, real room IDs/codes, names and messages are excluded from published JSON evidence.

The standalone package and release workflows enforce this new CI gate; adding the gate does not trigger publication or create a release. The PR remains Draft until both exact-head Windows Push and PR CI pass.
