# R14e — Historical database upgrade, spectator soak and Windows app-image restart

**Parent:** R14d Draft PR #86, final verified SHA `b40a9edd337c883a419a7ac3767b0b87c547c922`. R14e is stacked Draft only. No merge or release.

## Validation additions

### 1. Actual historical schema, rather than only a downgraded PRAGMA

`GameRoomHistoricalUpgradeR14eProbe` reconstructs the V28 database using the real V4–V28 SQL files, sets the same sequential SQLite `user_version` values as production, and inserts a legacy Board record. It upgrades a COPY of that database with `BoardGameDatabase.initialize()` across all V29–V44 migrations. Assertions include legacy data preservation, foreign-key check, SQLite integrity, GameRoom and telephone tables, one genuine pre-migration `schema-v25` backup, idempotent repeat initialization, restore of the backup to a distinct path, and successful re-upgrade from that restore. The initial historical fixture remains intact.

**Scope:** a deterministic synthetic V28 database containing a real Board row, not the user's production file. Historical SQL is loaded from the checked-out source tree; the probe runs in CI from the server directory. A production-data migration still requires a backup, snapshot, rollback plan and field acceptance on a sanitized replica.

### 2. Bounded concurrency and spectator soak

`GameRoomSpectatorSoakR14eProbe` runs with real SQLite persistence and independent Drawing/Yacht public rooms: 24 spectators per game (48 total), one player-host per room, and 6 concurrent chat sends per game (12 messages). Verifies overall room capacity versus actual players, all spectators receiving durable chat after repeated reads/heartbeats (five rounds), four disconnect/reconnect cycles per game, persisted chat and member counts after reopening SQLite, kick revocation and host closure.

**Scope:** deterministic bounded concurrency and repetition; not a long-duration soak, real WebSocket fan-out, internet latency, hundreds of simultaneous guests or capacity sizing benchmark. Elapsed time is recorded for diagnosis only, never compared with an arbitrary timing threshold.

### 3. Real packaged Windows application crash/restart

`server/smoke-packaged-game-room-restart.ps1` starts the actual `jpackage` application-image EXE with a disposable `BROADCASTING_GAME_PLATFORM_HOME`, random localhost ports, SOOP disabled and an isolated configuration/database. The running packaged server creates a real anonymous Yacht room and writes member-authorized chat. It is forcibly terminated to exercise SQLite WAL crash recovery, then restarted with the exact same root/config. Assertions require the room directory entry, original member session and chat history to survive. The test destroys its temporary files and checks the process is stopped.

The standalone Windows package CI and manual release workflow run this test after app-image creation. The release workflow already requires real Chrome/Edge E2E, so the new check is placed before any artifact publish. The static workflow contract ensures the R14e restart check cannot disappear unnoticed.

**Scope:** Windows app-image process launch/restart on GitHub runner. It does not claim MSI/EXE installer setup, signed binaries, Windows Defender reputation, tray-click graceful exit, clean workstation deployment, or continuous uptime.

## Required gates

- Historical upgrade V28→V44 and recovery from its auto-created migration backup pass.
- Both 24-viewer rooms, 12 concurrent chat sends, reconnect/closing rules pass.
- Existing server probes, Drawing 507/Yacht 95 static contracts, real Chrome/Edge GameRoom E2E 555+, native Windows package validation pass.
- Packaged EXE successfully starts **twice** and persists actual room/member/chat through a forced restart.
- Independent push and PR CI conclude SUCCESS at the same final commit.

## Residual release blockers

Production-data or anonymized large-database migration rehearsal; long-duration >24-hour multi-network load and actual WebSocket fan-out; unstable-network reconnect and reverse proxy with real certs; external SOOP channels; real installer/SmartScreen signing/tray-click exit; explicit human release approval. R14e does not grant permission to merge or publish.