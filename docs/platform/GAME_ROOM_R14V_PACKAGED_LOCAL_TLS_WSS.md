# R14v — Actual packaged Windows JVM over ephemeral localhost HTTPS/WSS

**Parent:** R14u Draft PR #103, verified SHA `8da227ffd6c1e30903a98943270db8b37420ae5d`. R14v remains independently stacked Draft and unreleased.

## Why this stage

R14r–t verified actual Windows packaged game state, auth, durable chat, player WebSockets and stale/duplicate Yacht commands over loopback HTTP and ws://. R14u added an operator-only public HTTPS/WSS two-player probe, but its real network client was only syntax/selftest checked in CI. **R14v runs that same R14u client end to end** with actual certificate verification through a local reverse proxy in front of the real packaged Windows app image. This closes an important untested TLS/WSS request/upgrade integration boundary without claiming a real WAN field test.

## Test architecture

The preexisting PowerShell packaged restart fixture starts the real `BroadcastingGamePlatformServer.exe`, its actual listening JVM, distinct loopback ports, disposable SQLite database and two genuine authenticated Yacht PLAYER memberships. R14v adds a fourth temporary port **bound to 127.0.0.1 only** for Node's built-in HTTPS termination and raw WebSocket upgrade forwarding. `GET /api/client/config` advertises the test-only secure WSS endpoint; all other permitted room REST and WebSocket requests are forwarded to the original packaged JVM. State-changing HTTP Origin is rewritten to the actual loopback backend origin, so this does **not** prove that a production reverse proxy's Origin/CORS headers are configured correctly.

PowerShell generates a new 2048-bit local-only RSA test certificate with `localhost` DNS and IPv4 SAN and a per-test private-key PFX under the isolated test root. It is **not installed into the Windows trust store**. Only the short-lived child R14u process uses `NODE_EXTRA_CA_CERTS` to trust this fixture certificate. No TLS validation bypass and no shared test private key are committed. The proxy and certificate are destroyed with the disposable fixture and the proxy port is checked for release.

On the **first** packaged JVM lifetime, R14v executes the real R14u client in its default **preflight** mode. It checks both members' authenticated HTTPS identity and current ACTIVE Yacht match, then verifies two actual WSS snapshots and clean socket closes. It does not issue explicit chat/roll POSTs. Note membership GET may cause server-side heartbeat changes and WSS subscribe can generate presence events.

On the **second** packaged JVM lifetime, after the existing R14r–t suite has committed five scored turns and an active guest's sixth-turn first roll, R14v invokes R14u's actual explicit **test consent** mode. It writes exactly two chat messages and issues **one** further Yacht roll in the disposable match; live WSS delivery, one disconnected-member cursor replay, duplicate chat and identical dice-roll retry, both members' game state consistency and clean closes are required. The independent strict R14u analyzer validates the raw local test report *inside the temporary fixture*. Those test-only raw files are never published as external field reports and are deleted with the fixture.

R14v's **separate** final write-once report uses source `packaged-windows-localhost-tls-proxy`; it records only success counters and attestation flags, with no token, host/room/member ID, chat text, certificate, private key, dice value, client address or backend port. The additional R14v strict analyzer checks two distinct process lifetimes, test-only TLS provenance, exactly two preflight WSS snapshots and three live-mode snapshots, chat replay and one dice command. Negative mutation tests reject malformed records, credential-bearing fields and any false public-field provenance.

## Windows CI and reproduction

The Windows package and manual-release workflow pass a fresh eighth report file to the existing real packaged restart fixture. The actual R14u client is launched only **inside the disposable PowerShell fixture**, using generated local-only credentials, never an external production endpoint. The GitHub workflow itself contains no real operator credentials/URLs and cannot turn this into a public test by setting an environment value.

Use PowerShell 7 with a completed Windows packaged build. Supply eight distinct fresh paths for existing R14k/l/m/n/r/s/t and R14v outputs:

    ./server/smoke-packaged-game-room-restart.ps1 -StopMode Graceful -TelemetryPath $r14k -LoadRounds 24 -LoadReportPath $r14l -WsSpectators 12 -WsReportPath $r14m -WsSoakCycles 6 -WsSoakReportPath $r14n -YachtReportPath $r14r -YachtWsReportPath $r14s -ConsistencyReportPath $r14t -LocalTlsReportPath $r14v
    node ./server/analyze-packaged-local-tls-wss.mjs --self-test
    node ./server/analyze-packaged-local-tls-wss.mjs "--input=$r14v" "--summary=$freshSummary"

## What this does not establish

This confirms a short real packaged Windows JVM HTTPS/WSS path **through ephemeral localhost TLS termination**. It is not public CA hostname validation, independently located workstations, WAN jitter/packet loss, 24-hour availability, operator-authorized real external room testing, Windows tray GUI verification, signed installer or upgrade/rollback. The R14u operator test, and R14o–q continuous field evidence, still need genuine supervised external execution and carefully retained deployment/network provenance.
