$ErrorActionPreference = "Stop"

$ServerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ServerRoot

Push-Location $RepoRoot
$server = $null
try {
    $server = Start-Process -FilePath "python" -ArgumentList @(
        "-m", "http.server", "8123",
        "--bind", "127.0.0.1",
        "--directory", "web"
    ) -PassThru -WindowStyle Hidden

    $probeUrl = "http://127.0.0.1:8123/tools/viewer-draw/marble/box2d-wasm-browser-probe.html"
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        if ($server.HasExited) {
            throw "browser physics HTTP server exited before readiness"
        }
        try {
            $response = Invoke-WebRequest -Uri $probeUrl -Method Head -TimeoutSec 1
            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
        }
        catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $ready) {
        throw "browser physics HTTP server did not become ready"
    }

    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    $browser = $candidates |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1

    if (-not $browser) {
        throw "Chrome/Edge headless browser not found"
    }

    $arguments = @(
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--virtual-time-budget=10000",
        "--dump-dom",
        $probeUrl
    )
    $dom = & $browser @arguments 2>&1 | Out-String

    if ($LASTEXITCODE -ne 0) {
        throw "headless browser probe failed: $dom"
    }
    if ($dom -notmatch 'data-status="pass"') {
        throw "box2d-wasm browser probe did not pass: $dom"
    }

    Write-Host "[browser-smoke] box2d-wasm probe passed"
}
finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force
    }
    Pop-Location
}
