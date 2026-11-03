# R14h — Windows packaged graceful shutdown and extended WebSocket endurance

**Parent:** R14g Draft PR #89, verified SHA `12c233003d4b3f0b92f99db7cfdcf62e59b8bb92`. This is a stacked Draft; no merge or release.

## Changes

1. **Real packaged EXE normal shutdown:** The existing R14e packaged smoke script now accepts `-StopMode Graceful`. It starts the actual jpackage Windows EXE with an isolated app root/config, SOOP disabled and ephemeral loopback ports, creates a public Yacht room and committed member chat, requests graceful shutdown, waits for **exit code zero**, checks the server log records both the requested exit and completed service closure, verifies **all three listener ports are released**, restarts with the original SQLite and bearer, verifies room/chat restoration, and repeats a second graceful shutdown. A failure still force-cleans its disposable process in `finally`.
2. **Identical code path to tray Exit:** The tray's “종료” action invokes `PlatformServerMain.explicitExit`, which runs the idempotent stop and then `System.exit(0)`. Because hosted Windows CI does not guarantee an interactive Explorer tray, the app accepts a **CI-only, local filesystem test trigger** `BGP_CI_GRACEFUL_EXIT_REQUEST` **only when `CI=true`**. The trigger path must be inside the `BROADCASTING_GAME_PLATFORM_HOME` root, and no network/control endpoint or normal-user command is enabled. The test hook calls the **same existing `explicitExit` runnable**, not a separate simulated cleanup. A “shutdown complete” marker is logged after the service close steps and before closing the file logger.
3. **Extended real WebSocket endurance:** Alongside the existing six-round default R14g regression test, package CI and the manual release workflow invoke the **real JDK/SQLite/WebSocket R14g probe for 24 rounds**. It tests Drawing+Yacht spectator reconnection, durable event replay and listener shutdown while pacing handshakes within existing anti-abuse limits. JVM thread/heap and elapsed time remain diagnostics.
4. **Pre-publish gates:** Both Windows workflows require existing browser E2E, all regression probes, extended endurance, actual EXE hard-stop recovery and the **new EXE graceful stop/restart** before artifact upload or release creation. The static integration workflow contract verifies ordering.

## Evidence requirements

- Final-head push and PR Windows CI conclude `success`.
- `GAME_ROOM_R14G_ENDURANCE_PASSED` with `rounds=24` appears in both logs.
- `GAME_ROOM_R14E_PACKAGED_RESTART_PASSED` remains passing.
- `GAME_ROOM_R14H_PACKAGED_GRACEFUL_EXIT_PASSED` confirms two normal exits and rebindable ports, with preserved Yacht room/chat session.
- Drawing/Yacht static contracts, browser HTTPS/WSS E2E and existing SQLite migration/revocation probes remain passing.

## What this does not prove

- **Actual Windows Explorer tray icon clicking is not automated.** The new CI trigger enters the same production exit callback, but manual desktop acceptance should right-click “종료” on a real Windows interactive session, check the tray icon disappears, process exits and restart restores a hosted room.
- The process-path smoke validates user-initiated graceful shutdown, **not** OS forced shutdown, power loss or machine sleep/resume.
- The 24-round test is bounded. It is not a 24-hour soak, multi-household WAN load, production TLS certificate/proxy topology or proof of no memory leak.
- No production data was opened and no installer/signature, merge or release action occurred.

## Manual Windows tray acceptance

Run the application-image EXE on an interactive Windows desktop with a disposable config/data root; verify the tray icon is present. Open Drawing or Yacht room, send a chat message, right-click the tray icon and select “종료”, verify the process exits and the HTTP/WS ports are released, then restart using the same root and confirm room/chat continuity. Repeat with SOOP configured (where authorized) and inspect shutdown logs. These steps require a human-operated desktop and should not be represented as CI-verified.
