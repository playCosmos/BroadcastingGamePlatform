$ErrorActionPreference = "Stop"

$ServerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ServerRoot

Push-Location $RepoRoot
$server = $null
$geometryFixture = Join-Path $RepoRoot "web/__board_room_geometry_probe.html"
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

    # Room creation retains two top-level panels, with persistent cell effects
    # on the left, sizing above the real preview, and only two buttons below it.
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
        'class="board-room-editor-pane"',
        'id="boardRoomInstructionList"',
        'id="boardRoomInstructionRows"',
        'class="board-room-size-controls"',
        'id="boardRoomSizingMode"',
        'id="boardRoomDimensionsFields"',
        'id="boardRoomCellCountField"',
        'id="boardRoomPreviewPanel"',
        'id="boardRoomPreviewPlaceholder"',
        'id="boardRoomPreviewFrame"',
        'class="board-room-layout-actions"',
        'id="boardRoomCreateButton"',
        'id="boardRoomCommitButton"'
    )) {
        if (-not $editorDom.Contains($required)) {
            throw "board room editor is missing $required"
        }
    }
    foreach ($removed in @(
        'id="boardRoomTabBoard"',
        'id="boardRoomTabEffects"',
        'id="boardRoomRerollButton"',
        'id="boardRoomOverlayRow"',
        'id="boardRoomExtendButton"',
        'id="boardRoomExtendMinutes"',
        'id="boardRoomTerminateButton"',
        'id="boardRoomPauseButton"',
        'id="boardRoomResumeButton"',
        'OBS 주소 복사',
        '새 창에서 열기',
        '룸 초안 생성 · 실제 배치 확인'
    )) {
        if ($editorDom.Contains($removed)) {
            throw "room creation must not contain $removed"
        }
    }
    if ($editorDom.Contains('id="boardRoomLiveSummary"') -or
        $editorDom.Contains('class="board-room-live-card"')) {
        throw "duplicate player status cards must not exist"
    }
    $avatarCount = ([regex]::Matches(
        $editorDom, 'class="board-room-live-avatar-shell"'
    )).Count
    $identityCount = ([regex]::Matches(
        $editorDom, 'class="board-room-player-identity"'
    )).Count
    $inlineStatusCount = ([regex]::Matches(
        $editorDom, 'data-live-status'
    )).Count
    if ($avatarCount -lt 2 -or $identityCount -lt 2 -or $inlineStatusCount -lt 2) {
        throw "every participant row must own its profile photo and live status"
    }
    if ($editorDom -notmatch 'class="board-room-player-identity"[\s\S]*?class="board-room-live-avatar-shell"') {
        throw "profile photos must be within participant identity rows"
    }
    $editorOrder = @(
        'class="board-room-editor-pane"',
        'id="boardRoomInstructionList"',
        'class="board-room-board-preview"',
        'class="board-room-size-controls"',
        'id="boardRoomPreviewPanel"',
        'id="boardRoomPreviewFrame"',
        'class="board-room-layout-actions"',
        'id="boardRoomCreateButton"',
        'id="boardRoomCommitButton"'
    )
    $previousIndex = -1
    foreach ($item in $editorOrder) {
        $index = $editorDom.IndexOf($item)
        if ($index -le $previousIndex) {
            throw "room creation controls are in the wrong order: $item"
        }
        $previousIndex = $index
    }
    if ($editorDom -notmatch 'id="boardRoomCreateButton"[^>]*[\\s\\S]*?data-placement-label>배치</span>') {
        throw "first placement action must contain its own icon and label"
    }
    if ($editorDom -notmatch 'id="boardRoomCommitButton"[^>]*disabled[^>]*[\\s\\S]*?data-commit-label>이 배치로 확정</span>') {
        throw "confirmation must contain its icon and remain disabled until DRAFT"
    }
    if ($editorDom -notmatch 'id="boardRoomRandomOptions" hidden' -or
        $editorDom -notmatch 'id="boardRoomRandomPoolMode"') {
        throw "random effects must start hidden but retain pool configuration"
    }
    if ($editorDom -match 'id="boardRoomSampleFrame"' -or
        $editorDom -match 'id="boardRoomPreviewFrame"[^>]+src="[^"]*demo=1') {
        throw "room editor must not substitute a demo board for real DRAFT preview"
    }
    if ($editorDom -notmatch 'id="boardRoomPreviewFrame"[^>]*hidden') {
        throw "room editor real-board iframe must start hidden before first placement"
    }
    Write-Host "[board-smoke] room creation layout, two actions and real server preview passed"

    # Inspect actual element geometry at wide and compact browser widths.
    # The fixture is temporary and never included in the Windows package.
    Copy-Item "server/fixtures/board-room-layout-probe.html" $geometryFixture -Force
    foreach ($width in @(1600, 1100, 820)) {
        $layoutDom = & $browser @(
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--window-size=${width},900",
            "--virtual-time-budget=4500",
            "--dump-dom",
            "$baseUrl/__board_room_geometry_probe.html"
        ) 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0 -or $layoutDom -notmatch 'data-geometry-state="pass"') {
            $details = [regex]::Match($layoutDom, 'data-geometry-details="([^"]*)"').Groups[1].Value
            throw "board room layout geometry failed at ${width}px: $details"
        }
    }
    Write-Host "[board-smoke] player alignment, movement rows, board sizing and top navigation geometry passed"

    Write-Host "[board-smoke] rounded and rect layouts passed"
}
finally {
    if ($geometryFixture -and (Test-Path $geometryFixture)) {
        Remove-Item $geometryFixture -Force
    }
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force
    }
    Pop-Location
}
