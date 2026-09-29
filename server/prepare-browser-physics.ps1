$ErrorActionPreference = "Stop"

$ServerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ServerRoot
$WebRoot = Join-Path $RepoRoot "web"
$NodeModules = Join-Path $WebRoot "node_modules"
$Source = Join-Path $NodeModules "box2d-wasm\dist\es"
$Vendor = Join-Path $WebRoot "vendor\box2d-wasm"

Push-Location $WebRoot
try {
    npm install --ignore-scripts --no-audit --no-fund --no-package-lock
    if ($LASTEXITCODE -ne 0) {
        throw "npm install for box2d-wasm failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

New-Item -ItemType Directory -Path $Vendor -Force | Out-Null

@(
    "entry.js",
    "Box2D.js",
    "Box2D.wasm",
    "Box2D.simd.js",
    "Box2D.simd.wasm"
) | ForEach-Object {
    $src = Join-Path $Source $_
    if (-not (Test-Path $src)) {
        throw "box2d-wasm browser asset missing: $src"
    }
    Copy-Item $src (Join-Path $Vendor $_) -Force
}

Remove-Item $NodeModules -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[browser-physics] prepared box2d-wasm 7.0.0 assets: $Vendor"
