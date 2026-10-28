# R13z — Latest-only public directory response and native round error fence

**Parent:** R13y Draft PR #81, exact verified SHA `b718e81fd3bd3bc2da86e260cd9f52eb1ddf93f2`.

## Reproduced risk

The Drawing GameRoom `loadPublicRooms()` unconditionally replaced `#publicRooms` when its HTTP GET completed. A held initial or manual request could resolve after another member was accepted and voluntarily left, overwriting a more recent public listing with an obsolete roster and room codes. Unlike member GETs, directory reads have no bearer and must use a **directory-specific request epoch**. The initial public listing error handler also could overwrite the current member's notice after admission.

The native drawer's `loadPrompt()` correctly fenced a returned answer to the initiating room member and round, but its asynchronous error handler only checked membership. If the same member advanced rounds before the older prompt failed, the old round's error still appeared in the current UI.

## Boundary

- Every directory GET increments `publicRoomsEpoch`. Commit the listing only if that epoch is still current; suppress superseded errors and return whether it committed.
- Accept and membership teardown invalidate and clear the old public directory immediately. On leaving, closing or revocation, start a fresh public listing (without a low-priority listing error overwriting the exit/revocation notice). Remove duplicate post-close GET.
- The manual refresh confirmation appears only for the latest completed directory response and same initiating membership. The boot-time listing failure is never allowed to overwrite a newly accepted room's notice.
- Only display a private prompt read failure when the member, drawer role and original active round identity all still match.
- Do not change public admission eligibility, server API, room capacities, anonymous guest parity, schema, permissions or persistent storage.

## Verification gates

- Static Drawing client contract tests cover epochs, success/error guards, both membership transitions, manual refresh and private prompt errors.
- Real Chrome and Edge exercise a held public directory GET, joining a hosted room while the old request is pending, leaving again, loading a newer authoritative listing, and finally releasing an older synthetic successful listing. Assert no older room entry, stale notice, stale member token, or blocked future directory refresh.
- Run all previous HTTP/SQLite/platform/browser checks and Windows x64 package verification at the exact PR head. Record exact SHA and Action runs.

## R13 integration audit snapshot

The current Drawing GameRoom now distinguishes member snapshots and auxiliary reads (R13s/t), native Canvas queue (R13v), telephone author/presenter actions (R13w), private room view teardown (R13x), general member mutations (R13y) and unauthenticated public directory reads (R13z). These protections target client-side delayed response isolation; they do **not** replace server authorization, live multi-device/mobile acceptance, or end-to-end release criteria. The R13 stacked Draft chain remains unmerged and unreleased.
