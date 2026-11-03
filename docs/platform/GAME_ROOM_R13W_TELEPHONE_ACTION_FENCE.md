# R13w — Telephone action responses must not cross room/session boundaries

**Parent:** verified R13v Draft PR #78, SHA `43b203eb9fc58eb544b21a991f980e3fc1fe2d69`.

## Risk

The GameRoom controller now fences stale room, chat, WSS and legacy Canvas responses. However, telephone.js still updates its module-global `state`, calls `discardStoredDraft()` and overwrites the room notice when an older `/drawing/telephone/submit`, `/present` or `/playback` request finishes. A member can move rooms while that request is in flight; the old response may erase the new room's draft or present old album slides in the new room. A pending presenter request can also leave the new session's `presenting` flag locked, and the 409-retry path can send a second request from the wrong room.

## Contract

- Track an internal telephone *view action epoch* derived from authenticated `roomId`, `memberId` and active stage identity (state, stage, server stage-start). Only change the epoch when that identity or phase changes; ordinary server refreshes in the same stage must preserve an active request.
- Every submit, presentation move and playback captures its epoch and request/refresh callbacks **before** awaiting. Recheck after each network await and before writing state, clearing the private tab draft, changing visible albums, refreshing UI or displaying an error. Ignore obsolete response/errors silently.
- For the 409 PAUSE/SPEED playback retry: if the view epoch changed, never issue the retry. Otherwise continue using the captured send function and revision from the authorized refreshed server response.
- Reset stale `submitting`/`presenting` flags when switching to a different view identity, so another room's author/presenter is not blocked by an unfinished previous operation; old `finally` handlers cannot unlock a newer operation.
- Avoid API changes, storing additional bearer tokens, new persistent data, altered presenter permission or implicit submission.

## Gates

- Static client contracts for identity epochs, action guard positions, same-phase refresh continuity, 409 retry fence and private draft cleanup scope.
- Real Chrome/Edge telephone NORMAL/COOP: hold a real old-host presentation POST, switch the same browser into an existing independent hosted room, release a synthetic old successful presentation, and verify the new room remains authoritative with no old albums, no stale notice and no blocked future author state. Include a second stale failed response path where possible.
- All prior platform probes, browser E2E and Windows x64 package verification at the PR's exact head. Stacked Draft; no merge or release.
