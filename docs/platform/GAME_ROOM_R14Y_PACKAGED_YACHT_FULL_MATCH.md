# R14y — Complete 26-turn two-player Yacht match in actual packaged Windows JVM

**Parent:** R14x Draft PR #106, CI-verified HEAD `8d7dba4c21fec4c30628014b60d25d5cdd4f19b6`. R14y is a stacked Draft with no production API, Java runtime, database migration, merge or release changes.

## Why

R14r–w already exercised real packaged Windows two-player Yacht gameplay, JVM restart and SQLite recovery, member WSS reconnect, five scored turns, duplicate/stale requests and localhost certificate-validated HTTPS/WSS. The acceptance chain did **not** finish a complete two-player 13-category match; the `FINISHED` → GameRoom `POST_GAME` transition and final score duplicate were not verified against an actual packaged JVM.

## Exact test

The existing isolated two-lifetime Windows packaged EXE fixture is unchanged until the R14v second-lifetime consent-controlled localhost TLS/WSS test finishes. R14y then starts a new **Node localhost-only** child with the two original disposable R14r players (tokens inherited only as child environment variables, never command arguments, logs or artifacts), using the existing match and same SQLite database.

- On entry the authoritative match must have **5 completed turns**, guest actively rolling its sixth turn, **two rolls** (R14t + R14v), the same room and two distinct player identities.
- For each of the **21 remaining score commits**, read the current active member and match version, issue a real server-generated dice roll if no roll exists, choose a score category from the server's legal `availableScores.points`, and commit exactly once. Validate turn number, room state, match ID, version, rolls and player rotation after every commit. Dynamic legal choices also respect a random natural Yacht / Joker possibility; no client-supplied dice or RNG seed.
- After exactly 26 scores, require both players' GET projections to show `FINISHED`, room `POST_GAME`, **13 distinct scored categories per player**, zero pending rolls, identical match/version and at least one version advance.
- Retry the final `score` with the **identical** command ID/payload after `FINISHED`; require exact original version/turn result. A new `roll` attempted after the match finishes must return **409**. Re-read current match and require no state change.
- The bounded worker must report only counts and booleans. No room, member, token, score value, category result, dice face, URI, port or process ID in final reports. A strict independently mutated JSON analyzer rejects malformed/secret-bearing/wrong-provenance evidence.
- Final report is created once **only after** both packaged EXE lifetimes have exited gracefully and their original listener ports are released. The separate R14v evidence remains unaffected.

The worker should emit `GAME_ROOM_R14Y_PACKAGED_YACHT_FULL_MATCH_PASSED players=2 scored=26 categories=13 postGame=true`, and the outer fixture should emit `GAME_ROOM_R14Y_PACKAGED_YACHT_FULL_MATCH_PASSED players=2 completed=26 postGame=true` after both real JVM graceful shutdowns.

## CI acceptance

Both package and manual release workflows pass a distinct ninth `-FullGameReportPath`, then check worker/analyzer syntax, run strict analyzer selftests and validate the actual sanitized packaged result. A new short-retention artifact `GameRoom-R14y-Packaged-Yacht-Full-Match` stores only the validated evidence and summary. Static workflow guard forbids omission, skipping the actual packaged process, or using external player credentials.

This does **not** prove remote WAN, public CA, signed installer, full visual GUI playthrough, randomized packet loss or sustained field availability. No public field traffic or live user data. **Draft/unmerged/unreleased**.
