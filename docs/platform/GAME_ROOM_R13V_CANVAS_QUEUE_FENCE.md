# R13v — Legacy drawing canvas send-queue session isolation

**Parent:** R13u Draft PR #77, head `8a184b9c29cffebba68385cdddd8fdfb788c8b5d`. R13u protected authenticated GET/WSS and common leave/close cleanup, but the legacy native drawing canvas still uses a promise-chain queue with mutable global session identity.

## Verified defect and expected behavior
- `drawCommand()` enqueues native canvas events (`stroke.begin`, `stroke.points`, `stroke.end`, `canvas.clear`). Each queued callback evaluates `request("/drawing/canvas","POST",{event})` using the **then-current global `secret`**, rather than the bearer of the member who drew the stroke. Old queued events may be sent to a newly accepted room if the preceding POST or networking blocks the chain.
- An old in-flight POST response invokes `applyEvent(result.json)` against the current canvas, potentially poisoning its sequence cursor and ink, even though the member credential changed. Old failures can also overwrite the new member's UI notice.

## Scope
- Capture `membershipGeneration` and `secret` at **enqueue time**. Recheck before initiating POST, pin the HTTP credential, then recheck after awaiting the response and before applying the event. Ignore stale errors and do not surface old failure notices.
- On accepting a new room, discard the old native canvas pointer gesture, pending point timer/points, rendered strokes, last stroke identifier and replay cursor **before** future drawing; the common `clearMembership()` should reuse this one native canvas reset helper. Keep the promise queue's ordering for current-session commands; ensure that old chains cannot affect the new room and avoid global shared queue corruption.
- The endpoint remains unchanged, no new storage or server state. This is for the native room drawing game, distinct from the Gartic telephone drawing editor and its tab-local unsent drafts.
- Stale commands must not advance an authoritative new room state, even if the old response is successful or fails with 403. Old errors must not show in the replacement room. A still-current command failure retains the existing notice behavior.
- Host/guest/spectator permissions, room limits, invitation/approval policy, and R1–R13u requirements remain unchanged.

## Required tests
- Static probe: enqueue-time session capture, POST bearer pinning, guards before send and after await, stale error suppression and native canvas reset on both accepted and cleared membership.
- Real Chrome/Edge browser: with a valid legacy drawing round, intercept the **first** native `/drawing/canvas` POST, enqueue a later stroke command, then voluntarily leave and host a new room in the **same tab**. After releasing the old POST result, verify queued old event never POSTs with the new token, old response never paints the new canvas, no old notice, and the new room remains authenticated. Then initiate a new round and verify new-session canvas POST still works. Preserve existing NORMAL+COOP telephone/yacht/room tests.
- Exact-head Windows platform workflow must pass static probes, full regression, Chrome and Edge, native Windows package/verify/upload. PR stacked Draft, no merge/release.
