# R14u — Operator-only external HTTPS/WSS two-player Yacht field test

**Parent:** R14t Draft PR #102 (verified HEAD `939b6aff63636859b0d76767652ec51adf5e3079`). R14u is a separate stacked Draft, unmerged/unreleased.

## What this tests

R14r–t already passed actual **isolated Windows packaged EXE** tests with two authenticated Yacht players and twelve separate spectators. R14o–q provided *independent operator field observers and correlation analysis*, but no real 24-hour physical tests have occurred.

R14u adds the missing **manual, consent-controlled public HTTPS/WSS real two-player client**. It requires an already-created **disposable** Yacht room containing **exactly two current players**, an ACTIVE match with a legal roll remaining, and **two different** bearer credentials belonging to that room. It never creates, joins, transfers, kicks, closes or changes capacity of any room. Unlike R14p's short-lived read-mostly snapshots, R14u's `--mode=run` intentionally **writes two chat messages and commits one actual dice-roll command**; it MUST NOT run against a production room or users.

The default `--mode=preflight` only verifies HTTPS identity, the actual server-advertised TLS-protected WSS address, distinct player credentials, the active Yacht match, and two authenticated WSS snapshots plus clean closes. **GET /me can refresh SQLite member/room heartbeat timestamps, and WSS subscribe can emit presence events**; therefore preflight has no explicit write API requests but is not literally side-effect-free at the server.

On explicitly approved `--mode=run`, the tool: opens both players' actual WSS sessions, posts chat from player A and verifies it arrives on both, disconnects player A, waits a bounded 250–5000 ms, commits chat from player B, verifies its live delivery to B, reconnects A using its last received event sequence and verifies actual cursor replay, retries B's identical chat and verifies no duplicate message or sequence, then reads durable chat from REST. It performs a single **server-authoritative Yacht roll** from the currently active player, retries exactly the same command ID/version and confirms no reroll, and reads `/yacht` from both players to ensure match ID, version, roll count and dice agree. All WebSockets must close cleanly.

**No score is recorded.** The test permanently advances the disposable test match by **one dice roll**. It is not a complete game, browser UI test, 24-hour measurement, network fault injector or proof of multiple physical client machines. You can run the tool from each approved physical network separately to collect independent evidence, but each run changes game state and must use a new disposable room with an available roll.

## Operator setup — PowerShell 7, Node 22+

Create a non-production HTTPS endpoint with valid publicly trusted TLS and a secure WSS endpoint advertised by `GET /api/client/config`. Prepare an isolated Yacht room with two joined PLAYERs and an ACTIVE match, no spectators, both members' already-issued bearer tokens, and the exact room UUID. Ensure both members explicitly consent to a synthetic chat and dice-roll test. Keep secrets in the operator console environment rather than arguments, URLs, docs or CI.

    $tokens = @(
        (Read-Host -Prompt "Disposable PLAYER 1 bearer" -MaskInput),
        (Read-Host -Prompt "Disposable PLAYER 2 bearer" -MaskInput)
    )
    $env:BGP_R14U_PLAYER_TOKENS_JSON = ConvertTo-Json -InputObject $tokens -Compress
    $env:BGP_R14U_TEST_ROOM_ID = Read-Host -Prompt "Disposable Yacht room UUID"
    node .\server\observe-external-yacht-two-player-field.mjs --base=https://your-test-host.example --mode=preflight

After successful preflight, **explicitly approve the one real dice roll and two chat writes**, choose a new local report file, and run:

    $env:BGP_R14U_EXPLICIT_WRITE_CONSENT = "I_APPROVE_DISPOSABLE_ROOM_CHAT_AND_DICE_ROLL"
    node .\server\observe-external-yacht-two-player-field.mjs --base=https://your-test-host.example --mode=run --delay-ms=600 --report=D:\GameRoomField\r14u-external-new.json
    node .\server\analyze-external-yacht-two-player-field.mjs --input=D:\GameRoomField\r14u-external-new.json --summary=D:\GameRoomField\r14u-summary-new.json
    Remove-Item Env:BGP_R14U_EXPLICIT_WRITE_CONSENT
    Remove-Item Env:BGP_R14U_PLAYER_TOKENS_JSON
    Remove-Item Env:BGP_R14U_TEST_ROOM_ID

If HTTPS and WSS terminate at different approved origins, specify `--wss=wss://fully-approved-host/path` and ensure it matches the server-advertised endpoint **exactly**. Certificate/hostname verification cannot be disabled. If the test fails during/after a write, the disposable room **may already have received chat or a dice mutation**; do not blindly rerun the same room. Inspect state and create fresh disposable accounts/room if necessary. Never use public production bearer tokens.

## Reports and evidence limits

The operator-local write-once JSON reports **only counters, TLS assertion, booleans, bounded delay and UTC observed time**. No room/member IDs, credentials, chat texts, game dice, addresses or URLs are recorded. `analyze-external-yacht-two-player-field.mjs` enforces a strict allowlist, counts, privacy flags and mutation tests; it does not contact servers. A passing analysis shows that an operator produced a *structurally complete* short session record, **not** cryptographic proof of the claimed network or deployment.

Operator acceptance should retain a **restricted separate session log** documenting the tested server/package version, client workstation and physical network, CA/proxy, time synchronization, consents, and expected room lifecycle. Keep full credentials out of logs. If testing different LAN/WAN sites, create separate room/test tokens and compare separate reports. Do not upload actual operator raw evidence to GitHub CI artifacts.

CI and manual release workflows validate **only Node syntax and synthetic analyzer self-tests**; they never invoke the external client, fetch a field report or inject bearer credentials. Existing localhost packaged R14r–t tests remain mandatory. Actual 24-hour field reliability, independent physically distributed clients, real WAN loss/jitter simulation, signed installer, upgrade/rollback and tray GUI testing remain outstanding.
