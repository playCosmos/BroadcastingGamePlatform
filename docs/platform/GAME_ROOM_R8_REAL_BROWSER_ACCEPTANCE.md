# GameRoom R8 — Real Chrome/Edge acceptance

This Draft milestone follows R7 room lifecycle PR #47. The test uses the **actual production Yacht and Drawing Guess HTML/CSS/JS**, the real migrated SQLite backend and the real HTTP/WebSocket servers in the same Windows CI environment.

## Implementation and isolation

- `server/src/test/java/.../GameRoomBrowserE2EServer.java` starts only loopback HTTP/WS interfaces, with a fresh temporary database and copies of the production browser assets. No admin session or login is provisioned.
- `server/game-room-browser-e2e.mjs` controls installed Chrome/Edge through DevTools Protocol using Node's native WebSocket, **without Playwright, Puppeteer, Selenium, an npm install, or checked-in binaries**. It creates **two isolated incognito browser contexts** so guest/host cookies and `sessionStorage` cannot silently share a member bearer.
- `server/smoke-game-room-browser.ps1` discovers Chrome/Edge on the Windows runner and launches the fixture + CDP driver after Maven regression tests and before packaging. The browser and fixture processes are terminated after success/failure.
- CI fails if a production form does not load, a real server call fails, a browser DOM result is missing, WebSocket kick closure fails, or mobile-width layout overflows.

## Covered scenarios

1. Drawing Guess: browser A submits the actual public room creation form without an account. Browser B finds/join the room as an anonymous SPECTATOR using the production form; verify exact total/player roles and session isolation.
2. Browser B subscribes to the production room WebSocket via a real member bearer. Browser A kicks B from an authenticated host API; WebSocket **must close 1008**. Browser B's own page must return to admission and delete the revoked token. Clearing browser storage must not resurrect the old bearer.
3. A newly admitted anonymous session can enter that still-open public room (no promise of cross-browser person recognition). The browser A host presses its visible '방 닫기' button, confirming closure; remaining member session is revoked and public listing no longer shows the room.
4. Yacht: both browser contexts visit the real Yacht page. Guest host creates a public room, guest joins as actual PLAYER, both press Ready, host starts a match; verify playing UI and that the host-close button is hidden during active play.
5. A real 390px mobile viewport is applied to the guest; assert no horizontal DOM overflow. This is **responsive DOM verification, not physical touch input**.
6. No uncaught JavaScript runtime exceptions are accepted in either real browser page.

## Existing and remaining validation

The R1–R7 Java probes and static browser contract tests remain in the Windows CI. This E2E adds a real-browser gate without replacing their exhaustive room authorization and persistence checks.

Still pending: Safari/Firefox and actual touch drawing, WAN and reverse-proxy HTTPS/WSS, multi-node behavior, long-running active-game abandonment and complete end-of-match UX across all games. No merge or release authorized.
