# R13u — Membership teardown and WebSocket credential ownership

**Stack:** Draft on verified R13t #76, branch `feature/common-game-room-r13t-async-read-fence` at `63ab912fbc4351f1069c150401555fc2ca71bfad`. Do not merge or release.

## Verified risks
- Forced kick/403 invalidation increments `membershipGeneration`, clears shared telephone view (and private tab-local unsent draft), clears snapshots, chat and host-only lists, closes sockets and returns to admission. **Voluntary leave and host close** instead only remove the bearer and some sockets and hide the room; the old `snapshot`, telephone view, tab-local unsent draft, channel labels, room/drawing binding and pending refresh generation remain inconsistent.
- Member WebSocket subscription already uses its captured `credential` but open, message and reconnect predicates still rely on mutable global `secret`; drawing socket open re-reads global `secret` and could attach a different member's token to an older socket if asynchronous socket replacement is not handled uniformly.

## Implementation
- Introduce one small `clearMembership()` routine called after successful voluntary leave, after successful host close, and by the existing revoked/403 flow. It increments `membershipGeneration` (invalidating in-flight reads), clears bearer, snapshot, telephone view/draft, chat and host-only labels, native drawing state, room/drawing bindings, socket references, sequence cursors and the stored membership. It returns the browser to the public admission UI. **Only forced revocation** records the existing revoked-member marker and notice; voluntary leave and close must not mark the browser as kicked.
- Preserve existing close/leave server API calls, confirm dialogs, role checks and guest equality. A failed leave or close must **not** clear the still-valid membership and its unsent draft.
- Bind both member and drawing WebSocket open/message/close/retry callbacks to the `generation`, `credential`, `roomId` or `drawingCode`, as appropriate. Subscribe using the exact credential captured when that WebSocket was created, never from a global variable.
- No new HTTP endpoints, database changes, client packages or storage formats.

## Acceptance
- Static contracts for shared cleanup, voluntary/forced distinction, socket bearer binding and phase-specific draft cleanup.
- Real Chrome+Edge NORMAL/COOP E2E: after completed gallery session, a nonhost player leaves through the actual button while a previous member refresh is held, then delayed old 403 is released and the admission screen, cleared token, cleared private draft/view and no old socket remain stable. The authenticated host closes an independently created room from the actual UI; it also clears state, old host lists and bearer without recording a kick marker. A fresh room admission from the same tab remains usable.
- All previous room/yacht/telephone probes, real Chrome/Edge multi-member acceptance and Windows x64 build/package validation must pass on the final exact PR head. Keep PR stacked Draft.
