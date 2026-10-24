# GameRoom R11 — foreground recovery and stale WebSocket close isolation

Draft follow-up to R10 (#50). Stacked on `feature/common-game-room-r10-recovery`; does not merge, release, alter anonymous admission, require an account, or introduce host approval.

## Observed reliability risk in the R10 clients

The Drawing Guess and Yacht clients each bind a logical room/game stream to a global socket. Their `close` event handlers previously checked only the logical room/code, then used an unconditional 1.8 s timeout to clear that binding and run `refresh()`.

When a closed connection is replaced with a fresh connection **for the same room/code**, a late close event or an already scheduled retry from the retired socket could clear the **new socket's binding**, force an unnecessary second handshake, and potentially duplicate event work. Drawing's member `open` callback also sent through the mutable global `memberSocket` rather than the connection that actually raised the event. This is a source-level race; the prior R10 CI pass did not exercise it.

## Changes

1. Every Drawing member/Canvas and Yacht member/game WebSocket listener captures its own `socket`. `open` and `message` from superseded sockets do not update the active UI. Every delayed retry checks `socket === currentSocket` and the current logical room/code **both before scheduling and at timeout execution**. The authenticated `room.subscribe` is sent only by the currently selected socket.
2. `visibilitychange` when returning to a visible tab, `online`, and persisted `pageshow` (bfcache restore) prompt a new authoritative refresh for a retained session. If a socket is already CLOSING/CLOSED, invalidate only its local logical binding so the existing refresh path reopens the transport. Healthy OPEN/CONNECTING sockets are not deliberately torn down.
3. Retain 3-second polling, server-side replay, member credential and chat cursor semantics. No guest identity reissuance, no new timer heartbeat, and no use of `localStorage` as the ban authority.

## Automated acceptance added to the existing Windows browser E2E

- Actual Chrome/Edge two-context TLS/WSS test instruments WebSocket creation in the **real spectator document** after it is loaded.
- After the R10 network interruption/replay checks, abruptly drop the member transport again, dispatch foreground/online signals, and verify a new member WebSocket opens.
- Dispatch a deliberately late `close` event on the **retired production socket** after the replacement has opened, wait through the 1.8 s retry window, and assert the new member socket remains OPEN with no extra member WebSocket allocation.
- Assert the spectator's anonymous member credential is unchanged.
- In the Yacht real two-player match, dispatch foreground/online signals and verify the PLAYING view and member credential persist.

The forced late `close` dispatch is **test-only** and exercises the actual registered production handler. No production socket mock is introduced. The transport drops continue to use a real TLS proxy and TCP teardown.

## Limitations and next gates

- Real hardware/tab suspension differs by browser and operating system. A synthetic foreground signal in Chrome/Edge does **not** claim genuine iOS background freeze/wake, Safari/Firefox behavior, cellular handoff, or CA-trusted external HTTPS/WSS.
- The existing 3-second background poll is subject to browser timer throttling. R11 ensures foreground/online triggers reconcile without waiting for that interval; it does not bypass browser resource policy while a tab remains suspended.
- Multi-process deployments, shared session transport and real WAN failure are still outside this local acceptance.

## Verification

Execute the existing `server/game-room-browser-e2e.mjs` through the Windows package workflow and retain the full R1–R10 regression set. Confirm exact-head CI before declaring acceptance or promoting any PR. Initial R11 code is submitted as **Draft / unverified until the new CI run completes**.
