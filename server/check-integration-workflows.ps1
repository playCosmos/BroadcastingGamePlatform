$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Package = Get-Content (Join-Path $RepoRoot ".github/workflows/platform-windows-package.yml") -Raw
$Release = Get-Content (Join-Path $RepoRoot ".github/workflows/release.yml") -Raw

# This is a static contract: the release workflow is manual and MUST NOT
# actually publish a GitHub Release from the ordinary CI.
foreach ($branch in @("feature/common-game-room-*", "feature/yacht-y*")) {
    if ([regex]::Matches($Package, [regex]::Escape($branch)).Count -ne 2) {
        throw "R14d: package workflow must include $branch in push and PR base filters"
    }
}
if ($Package -match "feature/common-game-room-r14[a-z]-") {
    throw "R14d: stage-specific GameRoom branch filters must not return"
}
if (-not $Package.Contains('".github/workflows/release.yml"')) {
    throw "R14d: release workflow changes must trigger Windows package CI"
}

$sourceGuard = '$releaseRef -ne "refs/heads/main"'
$releaseBranch = "refs/heads/release/"
$gate = "- name: Real GameRoom Chrome Edge browser E2E"
$regression = "- name: Run release regression probes"
$packaged = "- name: R14e packaged GameRoom startup and crash-restart"
$extended = "- name: R14h extended WebSocket endurance (24 rounds)"
$graceful = "- name: R14h packaged GameRoom graceful exit and restart"
$telemetry = "- name: R14j validate and summarize soak metrics"
$processTelemetry = "- name: R14k validate packaged EXE resource samples"
$packagedLoad = "- name: R14l verify packaged JVM HTTP SQLite soak (48 rounds)"
$packagedWs = "- name: R14m verify real packaged spectator WebSocket fanout"
$duration = "- name: R14n verify packaged Windows listener-JVM duration trend"
$fieldContract = "- name: R14o verify external field duration analyzer contract"
$externalContract = "- name: R14p verify external multi-client WSS field analyzer contract"
$correlatedContract = "- name: R14q verify combined JVM and external WSS field correlation"
$yachtRecovery = "- name: R14r validate actual packaged Yacht and guest chat recovery"
$yachtPlayerWs = "- name: R14s verify actual packaged Yacht player WSS reconnect and multiple turns"
$consistency = "- name: R14t verify real packaged chat duplicates and Yacht command consistency"
$externalYacht = "- name: R14u verify operator-only external Yacht two-player field contract"
$publish = "- name: Create or update GitHub Release"
foreach ($required in @($sourceGuard, $releaseBranch, $gate, $regression, $extended, $telemetry, $packaged, $graceful, $processTelemetry, $packagedLoad, $packagedWs, $duration, $fieldContract, $externalContract, $correlatedContract, $yachtRecovery, $yachtPlayerWs, $consistency, $externalYacht, $publish)) {
    if (-not $Release.Contains($required)) {
        throw "R14d: release workflow must contain the gate: $required"
    }
}
if (-not ($Release.IndexOf($regression) -lt $Release.IndexOf($gate) -and
           $Release.IndexOf($gate) -lt $Release.IndexOf($extended) -and
           $Release.IndexOf($extended) -lt $Release.IndexOf($telemetry) -and
           $Release.IndexOf($telemetry) -lt $Release.IndexOf($packaged) -and
           $Release.IndexOf($packaged) -lt $Release.IndexOf($graceful) -and
           $Release.IndexOf($graceful) -lt $Release.IndexOf($processTelemetry) -and
           $Release.IndexOf($processTelemetry) -lt $Release.IndexOf($packagedLoad) -and
           $Release.IndexOf($packagedLoad) -lt $Release.IndexOf($packagedWs) -and
           $Release.IndexOf($packagedWs) -lt $Release.IndexOf($duration) -and
           $Release.IndexOf($duration) -lt $Release.IndexOf($fieldContract) -and
           $Release.IndexOf($fieldContract) -lt $Release.IndexOf($externalContract) -and
           $Release.IndexOf($externalContract) -lt $Release.IndexOf($correlatedContract) -and
           $Release.IndexOf($correlatedContract) -lt $Release.IndexOf($yachtRecovery) -and
           $Release.IndexOf($yachtRecovery) -lt $Release.IndexOf($yachtPlayerWs) -and
           $Release.IndexOf($yachtPlayerWs) -lt $Release.IndexOf($consistency) -and
           $Release.IndexOf($consistency) -lt $Release.IndexOf($externalYacht) -and
           $Release.IndexOf($externalYacht) -lt $Release.IndexOf($publish))) {
    throw "R14d: the real browser suite must run before any release publish step"
}
if (-not $Package.Contains("run: ./server/check-integration-workflows.ps1")) {
    throw "R14d: the workflow gate contract must run in Windows CI"
}
if (-not $Package.Contains($packaged) -or
    -not $Package.Contains("run: ./server/smoke-packaged-game-room-restart.ps1")) {
    throw "R14e: Windows package CI must run actual packaged executable restart"
}
if (-not $Package.Contains($extended) -or -not $Package.Contains($graceful) -or
    -not $Package.Contains("GameRoomWebSocketEnduranceR14gProbe --rounds=24") -or
    -not $Package.Contains("smoke-packaged-game-room-restart.ps1 -StopMode Graceful") -or
    -not $Release.Contains("GameRoomWebSocketEnduranceR14gProbe --rounds=24") -or
    -not $Release.Contains("smoke-packaged-game-room-restart.ps1 -StopMode Graceful")) {
    throw "R14h: both Windows workflows must run extended WS soak and packaged graceful exit"
}
if (-not ($Package.IndexOf($extended) -lt $Package.IndexOf($packaged) -and
           $Package.IndexOf($packaged) -lt $Package.IndexOf($graceful) -and
           $Package.IndexOf($graceful) -lt $Package.IndexOf("- name: Upload Windows package"))) {
    throw "R14h: all shutdown gates must pass before Windows artifact upload"
}
$measurement = 'GameRoomWebSocketEnduranceR14gProbe --rounds=24 "--report=$report"'
$analysis = "analyze-game-room-soak.mjs"
foreach ($text in @($Package, $Release)) {
    if (-not $text.Contains($telemetry) -or
        -not $text.Contains($measurement) -or
        -not $text.Contains($analysis) -or
        -not $text.Contains("--self-test") -or
        -not $text.Contains("--min-rounds=24")) {
        throw "R14j: package and release CI must validate non-secret soak telemetry"
    }
}
if (-not ($Package.IndexOf($extended) -lt $Package.IndexOf($telemetry) -and
           $Package.IndexOf($telemetry) -lt $Package.IndexOf($packaged) -and
           $Package.IndexOf($graceful) -lt $Package.IndexOf("- name: Upload Windows package"))) {
    throw "R14j: telemetry analyzer must pass before package distribution"
}
if (-not $Package.Contains("Upload R14j soak metrics") -or
    -not $Package.Contains("game-room-r14j-summary.json")) {
    throw "R14j: sanitized measurements must be retained for inspection"
}
# R14k: do not silently replace real packaged-process sampling with the
# earlier disposable-JVM R14j metrics. Validate BOTH separate trust domains.
foreach ($text in @($Package, $Release)) {
    if (-not $text.Contains($processTelemetry) -or
        -not $text.Contains("smoke-packaged-game-room-restart.ps1 -StopMode Graceful -TelemetryPath") -or
        -not $text.Contains("node ./analyze-packaged-process-telemetry.mjs --self-test") -or
        -not $text.Contains('--input=$report') -or
        -not $text.Contains('--summary=$summary')) {
        throw "R14k: both workflows must sample and validate the real packaged Windows EXE"
    }
}
if (-not ($Package.IndexOf($graceful) -lt $Package.IndexOf($processTelemetry) -and
           $Package.IndexOf($processTelemetry) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($graceful) -lt $Release.IndexOf($processTelemetry) -and
           $Release.IndexOf($processTelemetry) -lt $Release.IndexOf($publish))) {
    throw "R14k: packaged EXE telemetry must be validated before distribution"
}
if (-not $Package.Contains("Upload R14k packaged EXE metrics") -or
    -not $Package.Contains("game-room-r14k-summary.json")) {
    throw "R14k: sanitized packaged EXE measurements must remain inspectable"
}
# R14l: the real Windows packaged listener JVM must perform the bounded
# HTTP and SQLite chat workload across both startup and restart lifecycles.
foreach ($text in @($Package, $Release)) {
    if (-not $text.Contains($packagedLoad) -or
        -not $text.Contains("-LoadRounds 24 -LoadReportPath") -or
        -not $text.Contains("node ./analyze-packaged-http-soak.mjs --self-test") -or
        -not $text.Contains("node ./analyze-packaged-http-soak.mjs") -or
        -not $text.Contains("--min-rounds=24")) {
        throw "R14l: both workflows must validate packaged HTTP/SQLite workload before distribution"
    }
}
if (-not ($Package.IndexOf($processTelemetry) -lt $Package.IndexOf($packagedLoad) -and
           $Package.IndexOf($packagedLoad) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($processTelemetry) -lt $Release.IndexOf($packagedLoad) -and
           $Release.IndexOf($packagedLoad) -lt $Release.IndexOf($publish))) {
    throw "R14l: package and release cannot skip the packaged HTTP workload gate"
}
if (-not $Package.Contains("Upload R14l packaged HTTP soak metrics") -or
    -not $Package.Contains("game-room-r14l-summary.json")) {
    throw "R14l: sanitized workload metrics must remain inspectable"
}
# R14m: the actual packaged JVM must fan out an authenticated chat event to
# twelve distinct spectator sockets, close them, then replay the next committed
# event from a durable cursor. Both Windows workflows enforce this gate.
foreach ($text in @($Package, $Release)) {
    if (-not $text.Contains($packagedWs) -or
        -not $text.Contains("-WsSpectators 12 -WsReportPath") -or
        -not $text.Contains("node --check ./smoke-packaged-websocket-fanout.mjs") -or
        -not $text.Contains("node ./analyze-packaged-ws-fanout.mjs --self-test") -or
        -not $text.Contains('node ./analyze-packaged-ws-fanout.mjs "--input=$ws" "--summary=$summary"')) {
        throw "R14m: both workflows must validate real packaged spectator WebSocket fanout"
    }
}
if (-not ($Package.IndexOf($packagedLoad) -lt $Package.IndexOf($packagedWs) -and
           $Package.IndexOf($packagedWs) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($packagedLoad) -lt $Release.IndexOf($packagedWs) -and
           $Release.IndexOf($packagedWs) -lt $Release.IndexOf($publish))) {
    throw "R14m: packaged WebSocket fanout gate must precede distribution"
}
if (-not $Package.Contains("Upload R14m packaged WS fanout metrics") -or
    -not $Package.Contains("game-room-r14m-summary.json")) {
    throw "R14m: sanitized packaged WS fanout data must remain inspectable"
}
# R14n: actual packaged Windows listener-JVM multi-cycle spectator duration,
# sampled while a child WebSocket client repeats connect/commit/replay.
foreach ($text in @($Package, $Release)) {
    if (-not $text.Contains($duration) -or
        -not $text.Contains("-WsSoakCycles 6 -WsSoakReportPath") -or
        -not $text.Contains("node ./analyze-packaged-ws-duration.mjs --self-test") -or
        -not $text.Contains('node ./analyze-packaged-ws-duration.mjs "--input=$duration" "--summary=$summary"')) {
        throw "R14n: both workflows must require packaged JVM duration trend acceptance"
    }
}
if (-not ($Package.IndexOf($packagedWs) -lt $Package.IndexOf($duration) -and
           $Package.IndexOf($duration) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($packagedWs) -lt $Release.IndexOf($duration) -and
           $Release.IndexOf($duration) -lt $Release.IndexOf($publish))) {
    throw "R14n: duration trend must be verified before distribution"
}
if (-not $Package.Contains("Upload R14n packaged JVM duration metrics") -or
    -not $Package.Contains("game-room-r14n-summary.json")) {
    throw "R14n: bounded nonsecret JVM duration observations must be inspectable"
}
# R14o validates the separate full-duration field analyzer and PowerShell
# syntax. Hosted CI must NEVER launch 24-hour data collection or publish a
# field certificate without genuine human-run Windows evidence.
foreach ($text in @($Package, $Release)) {
    if (-not $text.Contains($fieldContract) -or
        -not $text.Contains("node --check ./analyze-packaged-jvm-field.mjs") -or
        -not $text.Contains("node ./analyze-packaged-jvm-field.mjs --self-test") -or
        $text.Contains("observe-packaged-jvm-field.ps1 -AppRoot")) {
        throw "R14o: validate only the field analyzer in CI; never launch a field soak"
    }
}
if (-not ($Package.IndexOf($duration) -lt $Package.IndexOf($fieldContract) -and
           $Package.IndexOf($fieldContract) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($duration) -lt $Release.IndexOf($fieldContract) -and
           $Release.IndexOf($fieldContract) -lt $Release.IndexOf($publish))) {
    throw "R14o: field analyzer contract must pass before distributing packages"
}
# R14p: strictly read-only public TLS/WSS multi-member field validation.
# Hosted CI may validate schemas but MUST NOT run an external field probe
# or require member credentials, public endpoints or actual 24-hour uptime.
foreach ($text in @($Package, $Release)) {
    if (-not $text.Contains($externalContract) -or
        -not $text.Contains("node --check ./observe-external-wss-field.mjs") -or
        -not $text.Contains("node --check ./analyze-external-wss-field.mjs") -or
        -not $text.Contains("node ./analyze-external-wss-field.mjs --self-test") -or
        $text.Contains("BGP_WSS_FIELD_TOKENS_JSON") -or
        $text.Contains("observe-external-wss-field.mjs --base=")) {
        throw "R14p: do not connect hosted CI to public field member accounts"
    }
}
if (-not ($Package.IndexOf($fieldContract) -lt $Package.IndexOf($externalContract) -and
           $Package.IndexOf($externalContract) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($fieldContract) -lt $Release.IndexOf($externalContract) -and
           $Release.IndexOf($externalContract) -lt $Release.IndexOf($publish))) {
    throw "R14p: external WSS contract gate must precede publication"
}
# R14q may only validate synthetic correlated field reports. The real
# independently operator-controlled 24-hour files are never CI inputs.
foreach ($workflow in @($Package, $Release)) {
    if (-not $workflow.Contains($correlatedContract) -or
        -not $workflow.Contains("node --check ./analyze-correlated-field-evidence.mjs") -or
        -not $workflow.Contains("node ./analyze-correlated-field-evidence.mjs --self-test") -or
        $workflow.Contains("analyze-correlated-field-evidence.mjs --jvm=")) {
        throw "R14q: field correlation is syntax/synthetic-only in hosted CI"
    }
}
if (-not ($Package.IndexOf($externalContract) -lt $Package.IndexOf($correlatedContract) -and
           $Package.IndexOf($correlatedContract) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($externalContract) -lt $Release.IndexOf($correlatedContract) -and
           $Release.IndexOf($correlatedContract) -lt $Release.IndexOf($publish))) {
    throw "R14q: correlation contract must run before publication"
}
# R14r: a real packaged two-PLAYER Yacht match and distinct guest chat
# must survive a graceful packaged JVM restart. Unlike synthetic R14o-q
# fixtures, its sanitized report comes from the actual Windows EXE.
foreach ($text in @($Package, $Release)) {
    if (-not $text.Contains($yachtRecovery) -or
        -not $text.Contains('-YachtReportPath $yacht') -or
        -not $text.Contains("node ./analyze-packaged-yacht-recovery.mjs --self-test") -or
        -not $text.Contains('node ./analyze-packaged-yacht-recovery.mjs "--input=$report" "--summary=$summary"')) {
        throw "R14r: both workflows must verify real packaged Yacht game and guest chat recovery"
    }
}
if (-not ($Package.IndexOf($correlatedContract) -lt $Package.IndexOf($yachtRecovery) -and
           $Package.IndexOf($yachtRecovery) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($correlatedContract) -lt $Release.IndexOf($yachtRecovery) -and
           $Release.IndexOf($yachtRecovery) -lt $Release.IndexOf($publish))) {
    throw "R14r: actual packaged Yacht gate must run before distribution"
}
if (-not $Package.Contains("Upload R14r packaged Yacht recovery metrics") -or
    -not $Package.Contains("game-room-r14r-summary.json")) {
    throw "R14r: sanitized packaged Yacht measurements must be retained"
}
# R14s: actual two-player authenticated WebSocket sessions and multiple
# game turns must run on the same isolated packaged-JVM process lifetimes.
foreach ($text in @($Package, $Release)) {
    if (-not $text.Contains($yachtPlayerWs) -or
        -not $text.Contains('-YachtWsReportPath $playerWs') -or
        -not $text.Contains('node ./analyze-packaged-yacht-player-ws.mjs --self-test') -or
        -not $text.Contains('node ./analyze-packaged-yacht-player-ws.mjs "--input=$report" "--summary=$summary"') -or
        -not $text.Contains('node --check ./smoke-packaged-yacht-player-ws.mjs')) {
        throw "R14s: real packaged Yacht player WSS/turn CI contract missing"
    }
}
if (-not ($Package.IndexOf($yachtRecovery) -lt $Package.IndexOf($yachtPlayerWs) -and
           $Package.IndexOf($yachtPlayerWs) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($yachtRecovery) -lt $Release.IndexOf($yachtPlayerWs) -and
           $Release.IndexOf($yachtPlayerWs) -lt $Release.IndexOf($publish)) -or
    -not $Package.Contains("Upload R14s packaged Yacht player WebSocket evidence")) {
    throw "R14s: actual packaged player acceptance must precede distribution"
}
# R14t must verify real packaged duplicate/late chat and Yacht command
# idempotency. No public site, user credentials or 24-hour field files.
foreach ($workflow in @($Package, $Release)) {
    if (-not $workflow.Contains($consistency) -or
        -not $workflow.Contains('-ConsistencyReportPath $consistency') -or
        -not $workflow.Contains('node --check ./smoke-packaged-yacht-consistency.mjs') -or
        -not $workflow.Contains('node ./analyze-packaged-yacht-consistency.mjs --self-test') -or
        -not $workflow.Contains('node ./analyze-packaged-yacht-consistency.mjs "--input=$report" "--summary=$summary"')) {
        throw "R14t: real packaged duplicate and stale Yacht acceptance gate missing"
    }
}
if (-not ($Package.IndexOf($yachtPlayerWs) -lt $Package.IndexOf($consistency) -and
           $Package.IndexOf($consistency) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($yachtPlayerWs) -lt $Release.IndexOf($consistency) -and
           $Release.IndexOf($consistency) -lt $Release.IndexOf($publish)) -or
    -not $Package.Contains("Upload R14t packaged chat and Yacht consistency evidence")) {
    throw "R14t: actual packaged consistency results must gate distribution"
}
# R14u is manually opt-in against a consenting disposable remote room.
# CI validates offline source syntax and synthetic analysis ONLY.
foreach ($text in @($Package,$Release)) {
    if (-not $text.Contains($externalYacht) -or
        -not $text.Contains("node --check ./observe-external-yacht-two-player-field.mjs") -or
        -not $text.Contains("node --check ./analyze-external-yacht-two-player-field.mjs") -or
        -not $text.Contains("node ./analyze-external-yacht-two-player-field.mjs --self-test") -or
        $text.Contains("BGP_R14U_EXPLICIT_WRITE_CONSENT") -or
        $text.Contains("BGP_R14U_PLAYER_TOKENS_JSON") -or
        $text.Contains("observe-external-yacht-two-player-field.mjs --base=") -or
        $text.Contains("analyze-external-yacht-two-player-field.mjs --input=")) {
        throw "R14u: hosted CI must not contact real field or use test credentials"
    }
}
if (-not ($Package.IndexOf($consistency) -lt $Package.IndexOf($externalYacht) -and
           $Package.IndexOf($externalYacht) -lt $Package.IndexOf("- name: Upload Windows package") -and
           $Release.IndexOf($consistency) -lt $Release.IndexOf($externalYacht) -and
           $Release.IndexOf($externalYacht) -lt $Release.IndexOf($publish))) {
    throw "R14u: synthetic external field safety contract must precede distribution"
}
Write-Host "[workflow] R14u operator-only public HTTPS/WSS chat and Yacht field guard verified"
