# R14a — Yacht member-session and async response fence

Parent: R13z Draft PR #82, verified 86e18ff6614ba16338df0919a221deb4278c882a.

## Confirmed defect
Unlike Drawing GameRoom R13s–R13z, Yacht still read a mutable global bearer from async refresh, chat, commands, invitation, leave/close and WebSocket callbacks. A request begun in room A could complete after a tab joined B: a late 403 could revoke B; old Yacht state could show A roster; old host invite could disclose A invitation on B; old chat success could erase B unsent text. A single global busy lock blocked admission while an old member action waited.

## Changes
- A membership generation pins initiating bearer and response ownership; common save/clear teardown resets room text, chat, score, dice, invite, sockets, refresh and busy state.
- Old reads/403/errors cannot revoke or overwrite new sessions. Score/roll/hold, ready/seat, start, invitations, chat and exit/close use initiating member credentials and guard continuations.
- Admission has a separate lock so old room actions cannot block joining another room.
- WebSocket auth subscription, delayed callbacks/config, chat GET, public directory GET and directory errors are session/epoch fenced.
- On voluntary exit, host close or revocation, the public directory reloads without erasing higher-priority notices.

## Acceptance gates
- Yacht client static contract: member teardown, pin bearer, stale-response guards, guest access.
- Real Chrome/Edge fresh-fixture test with independent Yacht rooms A and B: hold an old authenticated room read and host invite while joining B, release 403 and old invite, verify B persists; then hold B chat while joining A, release old chat and verify new private draft; send real A chat.
- Preserve full Drawing NORMAL+COOP telephone E2E, Canvas, platform regression and Windows x64 package tests at exact head.

## Integration assessment
Yacht and Drawing still own their game-specific rendering and mechanics. Consider a shared client session abstraction only after independently verifying lifecycle semantics; avoid introducing code layers that increase cognitive distance.

Stacked Draft only. No merges, releases, schema changes, new dependencies or restrictions on anonymous play.