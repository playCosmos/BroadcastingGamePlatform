# R13n — Server-aligned telephone stage and slideshow clocks

**Stack:** R13n Draft on R13m #69. No merge/release or new dependency.

## Problem
R13m accurately treats expiration as server authority, but stage/progress/autoplay countdown currently use browser `Date.now()`. A misconfigured mobile/desktop wall clock can cause premature final-10 warnings or repeated unnecessary expiry refreshes, or hide server deadlines.

## Contract
- Include `serverNow` ISO-8601 UTC on every authorized telephone view (including inactive), sampled on the server at projection. This is timing metadata only; it must not expose album content, credentials, unrevealed prompts or alter endpoint semantics.
- Use the most recent *monotonically increasing* server sample and `performance.now()` elapsed time to estimate current server time. Prevent repeated/stale WebSocket/HTTP snapshots from winding time backwards. Device wall-clock jumps must not alter the timer after a server sample.
- The live stage progress, final-30/final-10 alerts, bounded deadline wake and reveal autoplay progress all use the same server-derived clock. The server still owns state transitions; client never submits/advances a phase on a local timeout. A single authenticated read at expiry (up to three backed-off attempts) remains the recovery hint.
- Support older servers with missing/invalid `serverNow` by falling back to existing local timer behavior. Reset clock estimate when room becomes inactive; do not clear valid clock on REVEAL because autoplay still uses it.
- Expose the real authoritative timestamp in backend service checks, verify it is close to server time, and that guest/spectator views remain private.

## CI acceptance
- Static contract: server field and monotonic calibration, both timers and deadline wake use calibrated clock, stale snapshots do not rewind, no new API/dependency.
- Real Chrome/Edge NORMAL+COOP: force client `Date.now` ahead/behind by hours; 10-second warnings must **not** appear, timer remains within stage bounds, server revision remains unchanged, and timer remains active. Independently advance the monotonic client clock in the test to exercise one-shot 10-second warning and locally expired status without server transition. Restore clocks and verify stage boundary resets. Show spectator timer without private prompt.
- Existing R1–R13m probes and exact-head Windows x64 package must pass.
