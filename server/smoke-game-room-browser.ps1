$ErrorActionPreference = "Stop"

$serverRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $serverRoot
try {
    $classPath = @(
        "target/test-classes",
        "target/classes",
        "target/probe-dependencies/*"
    ) -join [IO.Path]::PathSeparator

    if (-not (Test-Path "target/test-classes")) {
        throw "build server Maven test classes before browser E2E"
    }
    if (-not (Test-Path "target/probe-dependencies")) {
        throw "Maven probe dependencies missing"
    }

    $browsers = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    $browser = $browsers | Where-Object { Test-Path $_ } |
        Select-Object -First 1
    if (-not $browser) {
        throw "Chrome or Edge required for room browser E2E"
    }
    $env:GAME_ROOM_PROBE_CLASSPATH = $classPath
    node --version
    node ./game-room-browser-e2e.mjs $browser
    if ($LASTEXITCODE -ne 0) {
        throw "real GameRoom Chrome/Edge E2E failed ($LASTEXITCODE)"
    }
}
finally {
    Remove-Item Env:GAME_ROOM_PROBE_CLASSPATH -ErrorAction SilentlyContinue
    Pop-Location
}
