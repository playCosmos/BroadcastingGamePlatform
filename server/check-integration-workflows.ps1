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
$publish = "- name: Create or update GitHub Release"
foreach ($required in @($sourceGuard, $releaseBranch, $gate, $regression, $extended, $packaged, $graceful, $publish)) {
    if (-not $Release.Contains($required)) {
        throw "R14d: release workflow must contain the gate: $required"
    }
}
if (-not ($Release.IndexOf($regression) -lt $Release.IndexOf($gate) -and
           $Release.IndexOf($gate) -lt $Release.IndexOf($extended) -and
           $Release.IndexOf($extended) -lt $Release.IndexOf($packaged) -and
           $Release.IndexOf($packaged) -lt $Release.IndexOf($graceful) -and
           $Release.IndexOf($graceful) -lt $Release.IndexOf($publish))) {
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
Write-Host "[workflow] R14h integration, endurance and packaged graceful exit gates verified"
