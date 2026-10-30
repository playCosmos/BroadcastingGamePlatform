# R15b — actual packaged Windows six-player Yacht and 20-member room

**Parent:** R15a Draft PR #109 at exact CI-verified commit 6a73ef550582c580a715d21aef31203442e258d6. R15a verified six PLAYER Chrome/Edge tabs, fourteen member spectators (one real spectator browser tab), 78 turns and final UI. R15b validates the **shipped Windows EXE** rather than only the test JVM.

## Real shipped executable fixture

The existing Windows package/release graceful restart scenario launches the real packaged BroadcastingGamePlatformServer.exe twice, backed by disposable localhost-only configuration and SQLite. After the second launch's R14y 2-player Yacht completion, R15b runs a **separate six-player Yacht match** against the same packaged listener.

1. Host creates a new Yacht room through the real public HTTP API with maxPlayers=6 and maxRoomMembers=20.
2. The host issues **two bounded real HTTP invitations** (5 PLAYER uses, 14 SPECTATOR uses). Five other unique PLAYER identities join by invitation. The seventh PLAYER is rejected with 409 through the public admission API while spectator capacity remains.
3. Fourteen different SPECTATOR identities join by the bounded invitation, making exactly 20 distinct actual members, with host counted once. The twenty-first member is rejected with 409 through public admission. Spectator promotion to PLAYER is rejected while the player roster is full.
4. All six real players ready; spectator cannot start; host starts an actual authoritative match. At initial and final turns, spectators and non-active players cannot roll.
5. Across 78 turns the service chooses only server-advertised legal scores after real server-generated dice rolls, checks actual seat rotation, optimistic state version advance, score completion and transition to FINISHED / POST_GAME.
6. All **20 authenticated identities** independently read the same six final 13-category scorecards. Duplicate final score command replays exactly; postgame roll rejected without mutating match state.
7. After graceful shutdown, an isolated aggregate report is written with proof of two JVM lifetimes and port release, then verified by a strict offline analyzer and uploaded as short-retention artifact from the package CI.

**Success markers:**

- GAME_ROOM_R15B_PACKAGED_SIX_PLAYER_CAPACITY_PASSED players=6 spectators=14 members=20 turns=78 postGame=true
- GAME_ROOM_R15B_PACKAGED_SIX_PLAYER_CAPACITY_VALID players=6 spectators=14 members=20 turns=78 postGame=true

## Safety and boundaries

Scripts: server/smoke-packaged-yacht-six-player.mjs and server/analyze-packaged-yacht-six-player.mjs. The Windows fixture opts in via -SixPlayerReportPath (requires full R14y + R14v existing fixture) and writes disposable, non-identifying aggregate JSON evidence. The report contains no room codes, membership tokens, personally identifiable player names, dice values, or request secrets.

Applies to existing required Windows package and release regression jobs. It **does not trigger a release**, modify production game logic or DB schema, or test actual WAN/external-host/TLS/public certificates/multiple physical computers. This remains Draft/unmerged pending both exact-head Windows CI green and analyzer success.

The script's stdout and error handling are intentionally sanitized: do not log real credentials or room IDs even if a test fails.

## Public admission rate limits in the shared packaged fixture

R14m already uses twelve public `/public/join` calls for its earlier real WebSocket fanout test on the same second packaged JVM. The production public room join endpoint is limited to **30 operations/10 minutes per remote IP**, including rejected attempts. Sending nineteen more R15b public joins in that same listener would exceed this real abuse guard and return HTTP 429, which is *correct server behavior*, not a game-room defect. R15b therefore uses actual host-issued `/host/invite` + `/join` membership for nineteen admitted identities, while preserving public `/public/join` for seventh-player and twenty-first-member rejection probes. The invite lookup path has its own bounded rate protection, and each membership is still stored and authenticated by the production service. No security limit is increased or disabled.
