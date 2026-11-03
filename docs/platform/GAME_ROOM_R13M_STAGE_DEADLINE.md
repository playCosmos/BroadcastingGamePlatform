# R13m — Telephone stage countdown and deadline recovery

**Stack:** Draft R13m on R13l #68 (`feature/common-game-room-r13l-presenter-hotkeys`). Keep canonical server-owned deadline, private handoff, unsubmitted stage inputs and guests.

## User-facing behavior
- During active NORMAL/COOP telephone stages (including waiting and spectator views), show **remaining time** plus a responsive stage-time progress bar driven by the authenticated `stageStartedAt` and `seconds` snapshot. The bar counts down from 100% to 0%; there is no invented client deadline.
- Distinguish normal, final 30 seconds, final 10 seconds, and locally expired status. A separate polite screen-reader alert announces each threshold **once per room stage/deadline**, never once per tick and never after submission or on the gallery.
- A client clock crossing zero is **only a refresh hint**: request authoritative `GET /drawing/telephone` at most once per stage deadline, plus bounded retries if the server is not due or temporarily unreachable. Never force a phase transition, fabricate an album, disable or submit another player's input, or overwrite unsent text/ink. The server's existing lazy reconciliation remains authoritative.
- Suppress stale recovery completion across inactive rooms, changing stage, and new games. Keep the existing room's polling/WSS as a fallback and avoid hammering the server after zero. Remove the countdown/progress/alerts on REVEAL and inactive room.
- No external dependencies, new endpoints, migrations, private data in shared channels, or changes to guest/room role limits.

## Acceptance and regressions
- Static Drawing client contract checks the progress control, bounded warning threshold state, phase/deadline key, authoritative refresh-only wake, explicit absence of self-submission, and reveal reset.
- Real Chrome/Edge 3-player NORMAL and COOP E2E checks stage progress and accessible countdown, a deterministic client-clock 10s warning without actual server state mutation, repeated ticks do not duplicate alerts, a locally expired clock cannot advance authoritative phase, and stage switching resets warnings. Spectators receive timing/progress but not hidden content; reveal removes timer.
- Maintain R1–R13l regressions, package build, and exact-head Windows CI. Keep stacked Draft, no merge or release.
