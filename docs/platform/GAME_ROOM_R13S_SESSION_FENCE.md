# R13s — Fence stale authenticated game-room reads across session replacement

**Stack:** R13s Draft on R13r #74 (verified `91c9be66a2dcbf82739498595c1384017ffb4f51`). Keep earlier telephone drawing, author privacy, host cursor and WSS rules intact.

## Verified risk
`web/games/drawing-guess/room/room.js` performs two sequential `refresh()` GETs without binding their responses to one membership token. If a user creates/joins a different room while an old fetch is in flight, the first response can populate `snapshot` for the old room, the second can use the *new* credential, and a delayed old 403 can call `invalidateSession()` against the current room. `accept()` also does not clear the old `snapshot` immediately.

## Contract
- Introduce a monotonically changing **in-memory session generation**. Increment on replacement (`accept`) and invalidation (`invalidateSession`); clear the previous `snapshot`, telephone view and old room presentation before binding new membership.
- A refresh captures **one generation and bearer** at start and explicitly supplies that immutable bearer to **both** GETs. After each awaited step, drop results if membership generation/token changed. Only commit the pair to `snapshot` + `telephone` once both responses match. Do not invoke room rendering or socket/chat follow-ups for stale responses.
- Stale **403 errors** may not revoke a newer session; the current generation's 403 still performs existing kick/revocation behavior. Stale network errors must not overwrite the current user's notice. The busy/rerun mechanism must re-run the current session after the old request completes.
- WSS replay events remain wake-up hints; preserve the established authorized socket ownership checks and private telephone draft cleanup when a new token is accepted. No secret logs, new auth endpoints or changes to guest/account permissions.
- No new browser storage, DB migration, dependencies, merge or release.

## Verification
- Static client contracts for generation fencing and credential pinning before each asynchronous commit, immediate `snapshot` clearing on accept, stale-403 ignore, and existing WSS ownership rules.
- Real Chrome+Edge browser acceptance: hold a member GET for room A, switch same browser to a distinct hosted room B via the real public create form, release stale room-A 403 after B accepted, then verify B token and membership survive, room A's snapshot never renders and B refresh reconciles. A second delayed old 200 may be included when fixture permits.
- All R1–R13r regressions, real NORMAL+COOP browser suites, and Windows x64 build/package verification on the exact proposed head. Keep PR stacked Draft and unmerged.
