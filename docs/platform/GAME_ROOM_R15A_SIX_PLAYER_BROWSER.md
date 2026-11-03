# R15a — six real Yacht player browser tabs and 20-member room

**Stacked on R14z PR #108** at parent commit a67f5814d97bc2d1bcb076b564cdf5888ac54376 (separate Windows Push/PR CI green). Draft, unmerged and unreleased.

## Goal and test fixture

R14z validated 6 PLAYER + 14 SPECTATOR, total 20 members and full 78-turn Yacht over actual Java HTTP. R14y validated 2-player Yacht in the browser. R15a combines the upper player limit and real browser UI, using a separate disposable JVM/SQLite and Chrome/Edge fixture.

- Host creates a room with maxPlayers=6 and maxRoomMembers=20 using the real frontend form. Five independent player browser contexts and one spectator context join via real UI; thirteen more distinct spectator identities join via browser-originated HTTP. Host counts once. Block seventh PLAYER and twenty-first overall member with 409.
- Six separate player tabs click Ready; host clicks Start.
- Each of the six players executes their first Roll and Score via actual DOM buttons. The remaining 72 turns use authenticated requests issued from the same real Chrome contexts for bounded runtime; all scoring categories are from the current server-provided legal options.
- Assert exact 78 turns and six-player rotation. In all seven real browser tabs, verify POST_GAME, 경기 종료, six standings, 20 roster entries, 20/20 members, 6/6 players, and disabled roll/score buttons. Spectator reload must preserve private token and final scorecards.

Required console marker:
GAME_ROOM_R15A_BROWSER_SIX_PLAYER_CAPACITY_PASSED players=6 spectators=14 members=20 turns=78 uiPlayers=6 uiSpectators=1 reload=true

## Limits

This is seven independent real Chrome/Edge browser contexts (six players, one spectator), plus 13 distinct additional spectator identities over real localhost HTTP, **not 20 physical browser instances**. It is **not** a six-player packaged EXE, actual multi-PC WAN, production credentials, or deployment. No server production code/API/DB schema changes, no real stream accounts or secrets in success output.

The existing Windows package and release workflows run smoke-game-room-browser.ps1 as a mandatory browser E2E; failure of R15a fails the workflow. Both exact-head Windows Push and PR CI must pass before R15a is marked verified.
