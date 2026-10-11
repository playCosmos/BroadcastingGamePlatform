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
        },
        @{
            Name = "rounded-12x8"
            Url = "$baseUrl/games/board/index.html?demo=1&players=4&cols=12&rows=8"
            Engine = "reserve-first-loop-v4"
        },
        @{
            Name = "rect-12x8"
            Url = "$baseUrl/games/board/rect.html?demo=1&players=4&cols=12&rows=8"
            Engine = "rectilinear-loop-experimental"
        },
        @{
            Name = "rounded-minimum-8x6"
            Url = "$baseUrl/games/board/index.html?demo=1&players=4&cols=8&rows=6"
            Engine = "reserve-first-loop-v4"
        },
        @{
            Name = "rect-minimum-8x6"
            Url = "$baseUrl/games/board/rect.html?demo=1&players=4&cols=8&rows=6"
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
        # Every displayed cell must receive the readable instruction font-size
        # from the geometry pass (not the previous <=7.5px floor).
        $fontMatches = [regex]::Matches(
            $dom, '--cell-label-font:\s*(\d+(?:\.\d+)?)px'
        )
        if ($fontMatches.Count -lt 24) {
            throw "$($case.Name) did not size every instruction label"
        }
        foreach ($fontMatch in $fontMatches) {
            if ([double]::Parse(
                $fontMatch.Groups[1].Value,
                [System.Globalization.CultureInfo]::InvariantCulture
            ) -lt 9.99) {
                throw "$($case.Name) instruction font is below 10px baseline"
            }
        }
    }

    # The room editor must be one basic panel plus one tabbed workspace,
    # with a disabled preview until the server has created a real DRAFT.
    $editorUrl = "$baseUrl/admin/games/board/index.html"
    $editorDom = & $browser @(
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--virtual-time-budget=5000",
        "--dump-dom",
        $editorUrl
    ) 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "board room editor browser failed: $editorDom"
    }
    $panelCount = ([regex]::Matches(
        $editorDom, 'class="board-room-(primary|workspace)-panel"'
    )).Count
    if ($panelCount -ne 2) {
        throw "board room editor should have exactly two top-level panels, found $panelCount"
    }
    foreach ($required in @(
        'id="boardRoomTabBoard"',
        'id="boardRoomTabEffects"',
        'id="boardRoomTabPanelBoard"',
        'id="boardRoomTabPanelEffects"',
        'id="boardRoomPreviewPlaceholder"',
        'id="boardRoomPreviewFrame"',
        'id="boardRoomCreateButton"',
        'id="boardRoomCommitButton"'
    )) {
        if (-not $editorDom.Contains($required)) {
            throw "board room editor is missing $required"
        }
    }
    if ($editorDom -notmatch 'id="boardRoomTabBoard"[^>]*aria-selected="true"') {
        throw "board size/shape tab must be selected on load"
    }
    if ($editorDom -match 'id="boardRoomSampleFrame"' -or
        $editorDom -match 'id="boardRoomPreviewFrame"[^>]+src="[^"]*demo=1') {
        throw "room editor must not substitute a demo board for real DRAFT preview"
    }
    if ($editorDom -notmatch 'id="boardRoomPreviewFrame"[^>]*hidden') {
        throw "room editor real-board iframe must start hidden before DRAFT creation"
    }
    if ($editorDom -notmatch 'id="boardRoomPreviewPlaceholder"[^>]*>') {
        throw "room editor must show empty state before DRAFT creation"
    }
    Write-Host "[board-smoke] room editor two panels and server-only preview passed"

    Write-Host "[board-smoke] rounded and rect layouts passed"
}
finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force
    }
    Pop-Location
}
