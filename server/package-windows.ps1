param(
    [string]$Version = "0.1.0",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$ServerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ServerRoot
$DistRoot = Join-Path $ServerRoot "dist"
$InputRoot = Join-Path $ServerRoot "package-input"
$JarName = "broadcasting-game-platform-server-0.1.0-SNAPSHOT.jar"
$JarPath = Join-Path $ServerRoot "target\$JarName"
$AppRoot = Join-Path $DistRoot "BroadcastingGamePlatformServer"

if (-not $SkipBuild) {
    Push-Location $ServerRoot
    try {
        mvn --batch-mode --no-transfer-progress clean package
        if ($LASTEXITCODE -ne 0) {
            throw "Maven build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path $JarPath)) {
    throw "Server jar not found: $JarPath"
}

$jar = Get-Command jar -ErrorAction Stop
$jarEntries = & $jar.Source tf $JarPath
if ($LASTEXITCODE -ne 0) {
    throw "failed to inspect server jar"
}

$probeClasses = $jarEntries |
    Where-Object { $_ -match "Probe.*\.class$" }
if ($probeClasses) {
    throw "regression Probe classes must not be shipped in the production jar"
}

$selfCheckClass = $jarEntries |
    Where-Object {
        $_ -eq "io/github/playcosmos/broadcastinggameplatform/boardserver/BoardServerSelfCheck.class"
    }
if (-not $selfCheckClass) {
    throw "packaged server self-check class missing from production jar"
}

Remove-Item $DistRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $InputRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $DistRoot | Out-Null
New-Item -ItemType Directory -Path $InputRoot | Out-Null
Copy-Item $JarPath (Join-Path $InputRoot $JarName)

$jpackage = Get-Command jpackage -ErrorAction Stop
& $jpackage.Source `
    --type app-image `
    --name BroadcastingGamePlatformServer `
    --app-version $Version `
    --dest $DistRoot `
    --input $InputRoot `
    --main-jar $JarName `
    --main-class io.github.playcosmos.broadcastinggameplatform.boardserver.PlatformServerMain `
    --java-options "--enable-native-access=ALL-UNNAMED" `
    --java-options "-Dfile.encoding=UTF-8" `
    --java-options "-Dstdout.encoding=UTF-8" `
    --java-options "-Dstderr.encoding=UTF-8"

if ($LASTEXITCODE -ne 0) {
    throw "jpackage failed with exit code $LASTEXITCODE"
}

$Exe = Join-Path $AppRoot "BroadcastingGamePlatformServer.exe"
if (-not (Test-Path $Exe)) {
    throw "Packaged platform server executable was not created"
}

Copy-Item (Join-Path $ServerRoot "config.example.json") (Join-Path $AppRoot "config.example.json") -Force

$PrepareBrowserPhysics = Join-Path $ServerRoot "prepare-browser-physics.ps1"
& $PrepareBrowserPhysics
if ($LASTEXITCODE -ne 0) {
    throw "Browser physics asset preparation failed with exit code $LASTEXITCODE"
}

$WebSource = Join-Path $RepoRoot "web"
$WebRoot = Join-Path $AppRoot "web"
Copy-Item $WebSource $WebRoot -Recurse -Force
Copy-Item (Join-Path $RepoRoot "THIRD_PARTY_NOTICES.md") (Join-Path $AppRoot "THIRD_PARTY_NOTICES.md") -Force
New-Item -ItemType Directory -Path (Join-Path $AppRoot "data") -Force | Out-Null

$Readme = @"
Broadcasting Game Platform Server
=================================

현재 제공 게임 / 도구
--------------------
- 보드게임
- Drawing Guess
- Viewer Draw Random / Number
- Viewer Draw Marble Map Maker V1
- Viewer Draw Physics Preview Engine V1
- Viewer Draw Browser Box2D-WASM Marble Draw V1

접속 주소
---------
- 로컬 서버 관리: http://127.0.0.1:17830/
- 플랫폼 랜딩/API/운영자: http://127.0.0.1:17832/
- 실시간 WebSocket: 17831

설정 파일
---------
- 배포본에는 config.example.json만 포함됩니다.
- config.json이 없으면 최초 실행 때 자동 생성됩니다.
- 기존 config.json이 있으면 업데이트 시 덮어쓰지 않습니다.
- 운영 DB는 data/platform.db 입니다.
- schema migration 전에는 data/backups/ 아래에 최근 5개의 .bak 복구점을 유지합니다.

DB 복구
-------
1. BroadcastingGamePlatformServer를 완전히 종료합니다.
2. 현재 data/platform.db를 다른 이름으로 복사해 보존합니다.
3. 복구할 data/backups/*.bak 파일을 data/platform.db로 복사합니다.
4. 이전 실행의 platform.db-wal / platform.db-shm이 남아 있으면 별도로 보존한 뒤 제거합니다.
5. 서버를 다시 실행합니다. 이전 schema 백업이면 migration이 다시 적용됩니다.
6. 관리 화면과 주요 룸/추첨 데이터를 확인합니다.

실행 중인 서버의 DB 파일을 직접 덮어쓰지 마십시오.

외부 공개
---------
server.publicBaseUrl과 server.publicWebSocketUrl을 실제 공개 주소로 설정하십시오.
17830 관리 포트는 외부 공개하지 않습니다.

관리자 인증
-----------
- bootstrap token 링크 또는 /admin/ 직접 입력
- 토큰이 없는 사용자의 10분 유효 6자리 승인 요청
- 승인 후 고정 12시간 HttpOnly 관리자 세션
"@

Set-Content -Path (Join-Path $AppRoot "README.txt") -Value $Readme -Encoding UTF8
Remove-Item $InputRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[platform-package] created: $AppRoot"
Write-Host "[platform-package] executable: $Exe"
