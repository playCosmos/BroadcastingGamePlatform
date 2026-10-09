$ErrorActionPreference = "Stop"

$ServerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ServerRoot

Push-Location $RepoRoot
$server = $null
try {
    $server = Start-Process -FilePath "python" -ArgumentList @(
        "-m", "http.server", "8124",
        "--bind", "127.0.0.1",
        "--directory", "web"
    ) -PassThru -WindowStyle Hidden

    $baseUrl = "http://127.0.0.1:8124"
    $readyUrl = "$baseUrl/games/board/index.html?demo=1&players=4"
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        if ($server.HasExited) {
            throw "board smoke HTTP server exited before readiness"
        }
        try {
            $response = Invoke-WebRequest -Uri $readyUrl -Method Head -TimeoutSec 1
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
        throw "board smoke HTTP server did not become ready"
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

    $cases = @(
        @{
            Name = "rounded"
            Url = "$baseUrl/games/board/index.html?demo=1&players=4"
            Engine = "reserve-first-loop-v4"
        },
        @{
            Name = "rect"
            Url = "$baseUrl/games/board/rect.html?demo=1&players=4"
            Engine = "rectilinear-loop-experimental"
        }
    )

    foreach ($case in $cases) {
        $arguments = @(
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--virtual-time-budget=5000",
            "--dump-dom",
            $case.Url
        )
        $dom = & $browser @arguments 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            throw "$($case.Name) board browser failed: $dom"
        }
        if ($dom -notmatch 'data-layout-ready="true"') {
            throw "$($case.Name) board layout did not become ready"
        }
        $enginePattern = 'data-layout-engine="' + [regex]::Escape($case.Engine) + '"'
        if ($dom -notmatch $enginePattern) {
            throw "$($case.Name) board selected the wrong layout engine"
        }
        if ($dom -notmatch 'data-cell-index="0"') {
            throw "$($case.Name) board did not render cells"
        }
    }

    Write-Host "[board-smoke] rounded and rect layouts passed"
}
finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force
    }
    Pop-Location
}
