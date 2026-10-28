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
$publish = "- name: Create or update GitHub Release"
foreach ($required in @($sourceGuard, $releaseBranch, $gate, $regression, $publish)) {
    if (-not $Release.Contains($required)) {
        throw "R14d: release workflow must contain the gate: $required"
    }
}
if (-not ($Release.IndexOf($regression) -lt $Release.IndexOf($gate) -and
           $Release.IndexOf($gate) -lt $Release.IndexOf($publish))) {
    throw "R14d: the real browser suite must run before any release publish step"
}
if (-not $Package.Contains("run: ./server/check-integration-workflows.ps1")) {
    throw "R14d: the workflow gate contract must run in Windows CI"
}
Write-Host "[workflow] R14d staged CI branch filters and pre-release browser gate verified"
