$ErrorActionPreference = "Stop"

$ServerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ServerRoot

Push-Location $RepoRoot
try {
    $JavaScriptFiles = @(
        "web/admin/assets/platform-admin.js",
        "web/admin/assets/viewer-draw-number.js",
        "web/admin/assets/viewer-draw.js",
        "web/admin/assets/viewer-draw-map-engine.js",
        "web/admin/assets/viewer-draw-map-maker.js",
        "web/tools/viewer-draw/marble/browser-physics-adapter.js",
        "web/tools/viewer-draw/marble/viewer-draw-marble.js",
        "web/tools/viewer-draw/marble/viewer-draw-audit-sync.js",
        "web/admin/assets/drawing-guess-canvas.js",
        "web/admin/assets/drawing-guess-create.js",
        "web/admin/assets/drawing-guess-room.js",
        "web/games/drawing-guess/drawing-guess-overlay.js",
        "web/tools/viewer-draw/viewer-draw-overlay.js",
        "web/admin/assets/board-room-admin.js",
        "web/admin/assets/board-room-operation.js",
        "web/games/board/js/throw-presentation.js",
        "web/games/board/js/board.js",
        "web/games/board/js/board-rect.js"
    )

    foreach ($File in $JavaScriptFiles) {
        node --check $File
        if ($LASTEXITCODE -ne 0) {
            throw "JavaScript syntax check failed: $File"
        }
    }

    if (-not (Test-Path "web/vendor/box2d-wasm/entry.js")) {
        throw "box2d-wasm entry missing"
    }
    if (-not (Test-Path "web/vendor/box2d-wasm/Box2D.simd.wasm")) {
        throw "box2d-wasm SIMD wasm missing"
    }

    $NodeProbes = @(
        "web/admin/assets/viewer-draw-map-engine-probe.js",
        "web/tools/viewer-draw/marble/browser-physics-adapter-probe.js",
        "web/games/board/js/board-client-probe.js",
        "web/games/board/js/board-runtime-sync-probe.js"
    )
    foreach ($Probe in $NodeProbes) {
        node $Probe
        if ($LASTEXITCODE -ne 0) {
            throw "browser JavaScript probe failed: $Probe"
        }
    }

    Write-Host "[browser-check] JavaScript checks passed"
}
finally {
    Pop-Location
}
