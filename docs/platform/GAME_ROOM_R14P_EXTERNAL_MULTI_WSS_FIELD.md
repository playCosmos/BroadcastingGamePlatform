# R14p — External HTTPS/WSS multi-member field observation

Parent: R14o Draft PR #97, verified SHA 65c45476d19291cd23acb530700f78d834328510. This is stacked Draft only, not merged or released.

## Why and what is measured

R14o watches resource counters inside an actual running Windows packaged JVM. It cannot establish public HTTPS/WSS availability. R14p provides a separate operator-invoked, read-only Node 22+ observer to run on an external physical client/network against a real HTTPS public GameRoom endpoint with a valid CA certificate.

A prepared **disposable test room** must contain 2–12 distinct, already authenticated member/spectator credentials. The observer NEVER creates, joins, closes or changes a room, sends chat or game moves, modifies SQLite or starts/stops the server. At each scheduled interval it performs an authenticated member-session HTTPS GET for each user, opens up to twelve WSS sockets at once, verifies each scoped room snapshot, briefly holds them simultaneously, then closes them normally. Sockets are periodically reconnected, NOT held open for the entire day; this is multi-member availability and reconnect coverage, **not** a 24-hour continuous WebSocket fanout or heavy load.

TLS validation uses the normal Node HTTPS/WSS trust store and hostname checks. The observer refuses NODE_TLS_REJECT_UNAUTHORIZED=0, plain HTTP/WS and WSS addresses differing from advertised config unless an explicit, matching --wss URL is approved. No insecure TLS bypass is provided. The credentials and room UUID are read **only** from process environment variables, never from command line or report.

The JSONL report contains only aggregate read-only success/failure counts and WSS latency per round, timestamps, interval and duration data. No tokens, identifiers, URLs, hostnames, IPs, port numbers or chat contents are retained. Store results locally with restricted access, not in GitHub or support chats.

## Prepare in PowerShell 7 on the external PC

Start the Windows server on a separate machine with its approved HTTPS/WSS public proxy. Manually create a disposable test room and **twelve distinct spectator/member credentials** through the normal UI. On an external PC with Node 22+ enter bearers interactively with masked input, rather than typing them into command line history.

    $clients = 12
    $tokens = @(1..$clients | ForEach-Object { Read-Host -Prompt "Test member bearer $_" -MaskInput })
    $env:BGP_WSS_FIELD_TOKENS_JSON = ConvertTo-Json -InputObject $tokens -Compress
    $env:BGP_WSS_FIELD_ROOM_ID = Read-Host -Prompt "Disposable test room UUID"

Supply **exactly** as many distinct member tokens as --clients. They all must belong to the same test room. Do not reuse other users' production credentials.

## Full 24-hour observation

Use an absent/new report filename. This runs in the foreground on the external PC; it does not create a scheduled task or perform background delivery.

    node .\server\observe-external-wss-field.mjs --base=https://your-test-host.example --clients=12 --duration-seconds=86400 --interval-seconds=60 --report=D:\GameRoomField\wss-24h.jsonl

With 60-second spacing, 24 hours yields 1,441 observation rounds and up to 17,292 authenticated member GET and WSS snapshot attempts each. A failed member/snapshot/close is counted; the observer continues sampling until the requested duration, allowing analysis of partial availability. Interrupted observations lack a terminal completion record and are invalid for completed-run acceptance.

When the advertised public WSS endpoint is on another approved host, add an explicit --wss=wss://approved-wss-host.example/actual/path which **must** match the exact advertised public config endpoint. Do not disable TLS checks.

After observation, analyze the local report:

    node .\server\analyze-external-wss-field.mjs --self-test
    node .\server\analyze-external-wss-field.mjs --input=D:\GameRoomField\wss-24h.jsonl --summary=D:\GameRoomField\wss-24h-summary.json

The analyzer requires the full 86,400-second duration by default and exact ordered round records, expected samples, non-secret fields, outcome accounting and a final completion footer. It separates the predicates **fullDurationObserved** and **allReadOnlyChecksPassed**. The second is true only when zero member/WS snapshot/socket-close failures were recorded. Even a zero-failure sample is not proof of uninterrupted availability between polls or game correctness.

## One-minute smoke ONLY

For an isolated test room, with separate fresh report/summary filenames:

    node .\server\observe-external-wss-field.mjs --base=https://your-test-host.example --clients=12 --duration-seconds=60 --interval-seconds=10 --report=D:\GameRoomField\wss-smoke.jsonl
    node .\server\analyze-external-wss-field.mjs --input=D:\GameRoomField\wss-smoke.jsonl --summary=D:\GameRoomField\wss-smoke-summary.json --min-duration-seconds=60

The minimum override is explicit; a one-minute report cannot pass default 24h analysis. A smaller, pre-enrolled test room may use --clients=4 with exactly four tokens.

After use, clear credential-bearing environment variables:

    Remove-Item Env:\BGP_WSS_FIELD_TOKENS_JSON
    Remove-Item Env:\BGP_WSS_FIELD_ROOM_ID
    $tokens = $null

## Field and CI boundaries

Run the separate R14o actual Windows JVM sampler on the server PC during the same period if resource correlation is needed. R14o/R14p do not embed endpoint identities in reports; correlate UTC intervals through a separate secure operator-owned session log containing package version, machine identity and traffic schedule but **no bearer tokens**. For comprehensive acceptance also validate real user gameplay/chat and durable replay, multiple physical client networks, Windows tray controls, signed installer, upgrade and rollback.

Hosted GitHub Actions performs syntax checks and synthetic positive/negative report analysis only. It **never** invokes a live external public endpoint, uses member secrets, or completes a 24-hour field observation. Green CI is evidence that the tooling passes its contract tests, not that production uptime has been established.
