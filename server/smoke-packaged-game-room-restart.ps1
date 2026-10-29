param(
    [ValidateSet("Crash","Graceful")]
    [string]$StopMode = "Crash",
    [string]$TelemetryPath = ""
)
$ErrorActionPreference = "Stop"
if ($TelemetryPath -and $StopMode -ne "Graceful") { throw "R14k telemetry requires the graceful packaged process test" }
if ($TelemetryPath -and (Test-Path -LiteralPath $TelemetryPath)) { throw "R14k telemetry output already exists" }

# Exercise the shipped EXE, not just a Java self-check.
# All database, log and configuration paths are disposable and localhost-only.
$ServerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Join-Path $ServerRoot "dist/BroadcastingGamePlatformServer"
$Exe = Join-Path $AppRoot "BroadcastingGamePlatformServer.exe"
$WebRoot = Join-Path $AppRoot "web"
if (-not (Test-Path $Exe) -or -not (Test-Path (Join-Path $WebRoot "index.html"))) {
    throw "R14e packaged executable or web assets missing"
}

function FreeLocalPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return [int]$listener.LocalEndpoint.Port }
    finally { $listener.Stop() }
}
function Check([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "R14e package restart: $Message" }
}
function StartFixture([string]$ExePath, [string]$FixtureRoot, [string]$ConfigPath) {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $ExePath
    $start.ArgumentList.Add($ConfigPath)
    $start.WorkingDirectory = $FixtureRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.Environment["BROADCASTING_GAME_PLATFORM_HOME"] = $FixtureRoot
    if ($StopMode -eq "Graceful") {
        $start.Environment["CI"] = "true"
        $start.Environment["BGP_CI_GRACEFUL_EXIT_REQUEST"] = Join-Path $FixtureRoot "r14h-ci-exit.request"
    }
    return [System.Diagnostics.Process]::Start($start)
}
function AwaitApi([System.Diagnostics.Process]$Process, [string]$Uri) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        Check (-not $Process.HasExited) "server process exited during startup"
        try {
            return Invoke-RestMethod -Method Get -Uri $Uri -TimeoutSec 2
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    throw "R14e packaged server never opened its loopback HTTP endpoint"
}
function StopFixture([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) {
            # Simulates abrupt termination followed by WAL crash recovery.
            $Process.Kill($true)
            Check ($Process.WaitForExit(12000)) "packaged process stop timed out"
        }
    } finally {
        $Process.Dispose()
    }
}

function RequestGracefulStop([System.Diagnostics.Process]$Process, [string]$FixtureRoot, [int[]]$Ports) {
    $request = Join-Path $FixtureRoot "r14h-ci-exit.request"
    Check (-not (Test-Path $request)) "graceful request must not be present before startup"
    Set-Content -Path $request -Value "ci-graceful-stop" -Encoding ascii
    Check ($Process.WaitForExit(15000)) "graceful packaged exit timed out"
    Check ($Process.ExitCode -eq 0) "graceful packaged exit must return code zero"
    $logs = @(Get-ChildItem (Join-Path $FixtureRoot "logs") -Filter "broadcasting-game-platform-*.log" -Force -File |
        Sort-Object LastWriteTimeUtc -Descending)
    Check ($logs.Count -gt 0) "graceful exit must leave a server log"
    $text = Get-Content $logs[0].FullName -Raw -Encoding utf8
    Check ($text.Contains("[platform-server] shutdown complete")) "shutdown completed all service close steps"
    Check ($text.Contains("[platform-server] CI graceful exit requested")) "CI requested the same exit callback as tray menu"
    Remove-Item $request -Force
    foreach ($port in $Ports) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        try { $listener.Start() }
        catch { throw "R14h listener port not released after graceful exit: $port" }
        finally { $listener.Stop() }
    }
    $Process.Dispose()
}

# R14k: real packaged Windows EXE process counters only, not the isolated
# R14j JVM. Do not record PIDs, bearer tokens, room IDs, IPs or chat.
$script:TelemetrySamples = [System.Collections.Generic.List[object]]::new()
function RecordProcessSample([System.Diagnostics.Process]$Process, [int]$Launch, [string]$Phase) {
    if ([string]::IsNullOrWhiteSpace($TelemetryPath)) { return }
    Check (-not $Process.HasExited) "R14k process exited before resource sampling"
    $Process.Refresh()
    $script:TelemetrySamples.Add([ordered]@{
        launch = $Launch
        phase = $Phase
        workingSetBytes = [long]$Process.WorkingSet64
        privateBytes = [long]$Process.PrivateMemorySize64
        threadCount = [int]$Process.Threads.Count
        handleCount = [int]$Process.HandleCount
        cpuMs = [Math]::Round($Process.TotalProcessorTime.TotalMilliseconds, 2)
    })
}
function WriteProcessTelemetry {
    if ([string]::IsNullOrWhiteSpace($TelemetryPath)) { return }
    Check ($script:TelemetrySamples.Count -eq 4) "R14k expected four live EXE resource samples"
    $report = [ordered]@{
        kind = "packaged-process-telemetry"
        schemaVersion = 1
        process = "packaged-windows-exe"
        stopMode = "Graceful"
        samples = @($script:TelemetrySamples.ToArray())
        verifiedRestarts = 1
        verifiedGracefulExits = 2
        portsReleased = $true
        roomRecovered = $true
    }
    $stream = [IO.File]::Open($TelemetryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        try { $writer.WriteLine(($report | ConvertTo-Json -Depth 8 -Compress)) }
        finally { $writer.Dispose() }
    } finally { $stream.Dispose() }
}
$FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("bgp-r14e-package-" + [guid]::NewGuid().ToString("N"))
$Process = $null
$Checks = 0
try {
    New-Item -Path $FixtureRoot -ItemType Directory -Force | Out-Null
    $adminPort = FreeLocalPort
    $wsPort = FreeLocalPort
    $clientPort = FreeLocalPort
    Check (($adminPort -ne $wsPort) -and ($adminPort -ne $clientPort) -and ($wsPort -ne $clientPort)) "distinct loopback ports required"
    $config = @{
        streamerId = "r14e-packaged-test"
        server = @{
            host = "127.0.0.1"; port = $adminPort
            websocketPort = $wsPort; openBrowserOnStart = $false
            clientHost = "127.0.0.1"; clientPort = $clientPort
            publicBaseUrl = ""; publicWebSocketUrl = ""
        }
        storage = @{
            databasePath = "./data/packaged-r14e.sqlite"
            webRoot = $WebRoot
            logDirectory = "./logs"
        }
        soop = @{ enabled = $false; offlinePollSeconds = 30; additionalStreamerIds = @() }
    }
    $configPath = Join-Path $FixtureRoot "config.json"
    $config | ConvertTo-Json -Depth 10 | Set-Content -Path $configPath -Encoding utf8
    $api = "http://127.0.0.1:$clientPort/api/v1/room-membership"
    $listing = "$api/public/rooms?gameId=yacht"
    # The real GameRoom HTTP boundary rejects cross-origin state-changing
    # requests; mimic the browser's same-origin Origin header, not bypass ACL.
    $originHeaders = @{ Origin = "http://127.0.0.1:$clientPort" }
    $Process = StartFixture $Exe $FixtureRoot $configPath
    $initial = AwaitApi $Process $listing
    Check ($null -ne $initial -and ($initial.PSObject.Properties.Name -contains "rooms")) "first startup responds with public directory"
    $Checks++
    RecordProcessSample $Process 1 "ready"
    $body = @{gameId="yacht";name="R14e packaged persistent room";displayName="R14e host";hostSeat="PLAYER";maxPlayers=2;maxRoomMembers=4} | ConvertTo-Json -Compress
    $hosted = Invoke-RestMethod -Method Post -Uri "$api/public/hosted" -Headers $originHeaders -ContentType "application/json" -Body $body -TimeoutSec 10
    Check (-not [string]::IsNullOrEmpty($hosted.token)) "real anonymous host bearer issued"
    $Checks++
    $token = [string]$hosted.token
    $code = [string]$hosted.room.roomCode
    Check ($code.Length -eq 6) "real hosted room code"
    $Checks++
    $messageId = "r14ePackagedMessage1"
    $chatBody = @{messageId=$messageId;text="R14e durable chat"} | ConvertTo-Json -Compress
    $headers = @{ Authorization = "Bearer $token"; Origin = "http://127.0.0.1:$clientPort" }
    $posted = Invoke-RestMethod -Method Post -Uri "$api/chat" -Headers $headers -ContentType "application/json" -Body $chatBody -TimeoutSec 10
    Check ($posted.messageId -eq $messageId) "chat was persisted before restart"
    $Checks++
    RecordProcessSample $Process 1 "afterChat"
    if ($StopMode -eq "Graceful") {
        RequestGracefulStop $Process $FixtureRoot @($adminPort,$wsPort,$clientPort)
        $Checks += 5
    } else {
        StopFixture $Process
    }
    $Process = $null
    $databasePath = Join-Path $FixtureRoot "data/packaged-r14e.sqlite"
    Check (Test-Path $databasePath) "packaged server created SQLite database"
    $Checks++

    # Re-run the actual executable with the same root and database.
    $Process = StartFixture $Exe $FixtureRoot $configPath
    $after = AwaitApi $Process $listing
    Check (@($after.rooms | Where-Object { $_.roomCode -eq $code }).Count -eq 1) "hosted public room survived hard-stop restart"
    $Checks++
    RecordProcessSample $Process 2 "ready"
    $me = Invoke-RestMethod -Method Get -Uri "$api/me" -Headers $headers -TimeoutSec 10
    Check ($me.room.roomCode -eq $code) "original member session survives restart"
    $Checks++
    $messages = Invoke-RestMethod -Method Get -Uri "$api/chat?after=-1" -Headers $headers -TimeoutSec 10
    Check (@($messages.messages | Where-Object { $_.messageId -eq $messageId }).Count -eq 1) "durable room chat survives restart"
    $Checks++
    RecordProcessSample $Process 2 "afterReplay"
    Check (-not $Process.HasExited) "restarted Windows app remains running"
    $Checks++
    if ($StopMode -eq "Graceful") {
        RequestGracefulStop $Process $FixtureRoot @($adminPort,$wsPort,$clientPort)
        $Process = $null
        $Checks += 5
        WriteProcessTelemetry
        Write-Host "GAME_ROOM_R14H_PACKAGED_GRACEFUL_EXIT_PASSED checks=$Checks shutdowns=2 ports=3"
    } else {
        Write-Host "GAME_ROOM_R14E_PACKAGED_RESTART_PASSED checks=$Checks"
    }
} finally {
    StopFixture $Process
    if (Test-Path $FixtureRoot) {
        Remove-Item $FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
