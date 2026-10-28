# R13y — General member action continuations are session-scoped

**Parent:** R13x Draft PR #80, verified head `560ba0a5dcccdca4ce7ce7c063b005f4c2cf4277`.

## Verified risk

The native GameRoom controller already fences read responses, native Canvas
commands and Gartic-style telephone actions. However the shared
`operation()` wrapper and its handlers still used the mutable member token
at request time. Its successful continuations unconditionally committed
`snapshot`, reset text inputs, displayed an old room invite token, wrote
notices or ran a new-room refresh. Its error/finally handlers could also
overwrite a replacement session's notice or unlock its action lock.
Most importantly, a pending old-room mutation set a **global** `busy` flag,
making an independent public admission silently no-op while that POST hung.

## Contract

- `operation()` captures the current `membershipGeneration` and bearer,
  offers a credential-pinned `send()` and `current()` to every member
  action, and ignores stale outcomes. Its member-scoped serialization remains
  active for commands within one session.
- Public creation, public room-code admission and private invitation admission
  use a separate admission lock: they can succeed while an unrelated old-room
  POST is blocked. They still reject stale admission responses and serialize
  concurrent admission attempts. `accept()` and `clearMembership()` detach
  obsolete busy locks, including the accessibility `aria-busy` state.
- Pin host channel add/remove, streamer assignment, ready/seat, native and
  telephone starts, native round/guess/complete/finish, host invitation,
  chat POST, voluntary leave and host close. Check `current()` after the
  awaited request and before mutating snapshot, forms, invitation DOM,
  notice or member identity. Clear/leave only the original member.
- Host room-ID clipboard feedback also checks its initiating member. Existing
  authorization, server-side audit, idempotency semantics and private draft
  safeguards are unchanged.

## Acceptance gates

- Static JS contracts assert every member POST uses the captured bearer,
  all three public/private admissions bypass stale member locks, and
  stale form/notice/teardown guards exist.
- Dedicated real Chrome/Edge NORMAL+COOP fixture with two independent
  public hosted rooms: hold an actual old host-invite POST while joining
  room B through the same browser tab, then release a synthetic successful
  old invite. Verify no old invite, stale notice, or busy lock reappears.
  Hold a real room-B chat POST, admit room A again and seed new unsent
  chat text, release the old POST, verify the new text and notice survive,
  then send new legitimate chat to prove the replacement operation works.
- Retain all previous platform regressions, real browser acceptance and
  Windows x64 build/package validation at the exact PR head.
- **Draft only. Do not merge, release, change schemas, add dependencies or
  restrict anonymous play.**
