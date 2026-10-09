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
$probeClasses = & $jar.Source tf $JarPath |
    Where-Object { $_ -match 'Probe.*\.class
if ($LASTEXITCODE -ne 0) {
    throw "failed to inspect server jar"
}
if ($probeClasses) {
    throw "regression Probe classes must not be shipped in the production jar"
}

$selfCheckClass = & $jar.Source tf $JarPath |
    Where-Object { $_ -eq 'io/github/playcosmos/broadcastinggameplatform/boardserver/BoardServerSelfCheck.class' }
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

# Never ship a live config.json. First launch creates it only when missing.
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

플랫폼 역할
-----------
- 방송 게임 플랫폼 랜딩 페이지
- 운영자 인증/관리자 세션
- 게임별 룸 생성/운영
- OBS 브라우저 오버레이
- 플랫폼 API
- SOOP 채팅/후원 Provider
- 공용 Event Bus
- Marble Machine Map 저장/리비전/hash
- 브라우저 독립 Marble 물리 추첨
- 추후 CHZZK Provider 확장

접속 주소
---------
- 로컬 서버 관리: http://127.0.0.1:17830/
- 플랫폼 랜딩/API/운영자: http://127.0.0.1:17832/
- 실시간 WebSocket: 17831

설정 파일
---------
- 배포본에는 config.example.json만 포함됩니다.
- config.json이 없으면 최초 실행 때 자동 생성됩니다.
- 기존 config.json이 있으면 업데이트 시 덮어쓰지 않고 그대로 사용합니다.
- 운영 DB는 data/platform.db 입니다.

외부 공개
---------
config.json의 아래 값을 실제 공개 주소로 설정하십시오.

server.publicBaseUrl
  예: https://games.example.com

server.publicWebSocketUrl
  예: wss://games.example.com/ws

17830 관리 포트는 외부 공개하지 않습니다.

관리자 인증
-----------
- 토큰 포함 링크
- /admin/에서 토큰 직접 입력
- 토큰이 없는 사용자의 10분 유효 6자리 승인 요청
- 승인 후 12시간 HttpOnly 관리자 세션

현재 저장소에는 기존 Roulette/Lotto/Ticket 기능이 포함되지 않습니다.
"@
Set-Content -Path (Join-Path $AppRoot "README.txt") -Value $Readme -Encoding UTF8

Remove-Item $InputRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[platform-package] created: $AppRoot"
Write-Host "[platform-package] executable: $Exe"
 }
if ($LASTEXITCODE -ne 0) {
    throw "failed to inspect server jar"
}
if ($probeClasses) {
    throw "regression Probe classes must not be shipped in the production jar"
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

# Never ship a live config.json. First launch creates it only when missing.
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

플랫폼 역할
-----------
- 방송 게임 플랫폼 랜딩 페이지
- 운영자 인증/관리자 세션
- 게임별 룸 생성/운영
- OBS 브라우저 오버레이
- 플랫폼 API
- SOOP 채팅/후원 Provider
- 공용 Event Bus
- Marble Machine Map 저장/리비전/hash
- 브라우저 독립 Marble 물리 추첨
- 추후 CHZZK Provider 확장

접속 주소
---------
- 로컬 서버 관리: http://127.0.0.1:17830/
- 플랫폼 랜딩/API/운영자: http://127.0.0.1:17832/
- 실시간 WebSocket: 17831

설정 파일
---------
- 배포본에는 config.example.json만 포함됩니다.
- config.json이 없으면 최초 실행 때 자동 생성됩니다.
- 기존 config.json이 있으면 업데이트 시 덮어쓰지 않고 그대로 사용합니다.
- 운영 DB는 data/platform.db 입니다.

외부 공개
---------
config.json의 아래 값을 실제 공개 주소로 설정하십시오.

server.publicBaseUrl
  예: https://games.example.com

server.publicWebSocketUrl
  예: wss://games.example.com/ws

17830 관리 포트는 외부 공개하지 않습니다.

관리자 인증
-----------
- 토큰 포함 링크
- /admin/에서 토큰 직접 입력
- 토큰이 없는 사용자의 10분 유효 6자리 승인 요청
- 승인 후 12시간 HttpOnly 관리자 세션

현재 저장소에는 기존 Roulette/Lotto/Ticket 기능이 포함되지 않습니다.
"@
Set-Content -Path (Join-Path $AppRoot "README.txt") -Value $Readme -Encoding UTF8

Remove-Item $InputRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[platform-package] created: $AppRoot"
Write-Host "[platform-package] executable: $Exe"
