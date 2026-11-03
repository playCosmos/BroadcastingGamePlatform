param(
    [ValidateSet("Crash","Graceful")]
    [string]$StopMode = "Crash",
    [string]$TelemetryPath = "",
    [ValidateRange(0,10000)]
    [int]$LoadRounds = 0,
    [string]$LoadReportPath = "",
    [ValidateSet(0,12)]
    [int]$WsSpectators = 0,
    [string]$WsReportPath = "",
    [ValidateSet(0,6)]
    [int]$WsSoakCycles = 0,
    [string]$WsSoakReportPath = "",
    [string]$YachtReportPath = ""
)
$ErrorActionPreference = "Stop"
if ($TelemetryPath -and $StopMode -ne "Graceful") { throw "R14k telemetry requires the graceful packaged process test" }
if ($TelemetryPath -and (Test-Path -LiteralPath $TelemetryPath)) { throw "R14k telemetry output already exists" }
if ($LoadRounds -gt 0) {
    if ($LoadRounds -lt 2 -or $StopMode -ne "Graceful" -or
        [string]::IsNullOrWhiteSpace($LoadReportPath) -or
        [string]::IsNullOrWhiteSpace($TelemetryPath)) {
        throw "R14l load requires 2+ rounds, graceful stop, and separate R14k/R14l output paths"
    }
    if ([IO.Path]::GetFullPath($LoadReportPath) -eq [IO.Path]::GetFullPath($TelemetryPath) -or
        (Test-Path -LiteralPath $LoadReportPath)) {
        throw "R14l telemetry must use a new distinct path"
    }
} elseif ($LoadReportPath) {
    throw "R14l report path requires LoadRounds"
}
if ($WsSpectators -gt 0) {
    if ($StopMode -ne "Graceful" -or $LoadRounds -lt 2 -or
        [string]::IsNullOrWhiteSpace($WsReportPath)) {
        throw "R14m fan-out requires graceful R14l packaged load and a distinct new report"
    }
    $outputs = @($WsReportPath,$LoadReportPath,$TelemetryPath) |
        ForEach-Object { [IO.Path]::GetFullPath($_) }
    if ($outputs.Count -ne @($outputs | Select-Object -Unique).Count) { throw "R14m report files must be distinct" }
    if (Test-Path -LiteralPath $WsReportPath) {
        throw "R14m fan-out report already exists"
    }
} elseif ($WsReportPath) {
    throw "R14m report path requires 12 spectators"
}
if ($WsSoakCycles -gt 0) {
    if ($WsSpectators -ne 12 -or $LoadRounds -lt 2 -or
        [string]::IsNullOrWhiteSpace($WsSoakReportPath)) {
        throw "R14n bounded duration soak requires R14m 12 spectators and its distinct report"
    }
    $paths = @($TelemetryPath,$LoadReportPath,$WsReportPath,$WsSoakReportPath) |
        ForEach-Object { [IO.Path]::GetFullPath($_) }
    if ($paths.Count -ne @($paths | Select-Object -Unique).Count -or
        (Test-Path -LiteralPath $WsSoakReportPath)) {
        throw "R14n report output must be new and distinct"
    }
} elseif ($WsSoakReportPath) {
    throw "R14n report path requires -WsSoakCycles 6"
}
if ($YachtReportPath) {
    if ($StopMode -ne "Graceful" -or $WsSoakCycles -ne 6) { throw "R14r requires R14n full packaged fixture" }
    $paths = @($TelemetryPath,$LoadReportPath,$WsReportPath,$WsSoakReportPath,$YachtReportPath) | ForEach-Object { [IO.Path]::GetFullPath($_) }
    if (@($paths | Select-Object -Unique).Count -ne 5 -or (Test-Path $YachtReportPath)) { throw "R14r report output must be new and distinct" }
}

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

# R14k: measure the actual packaged JVM that OWNS all three live listeners.
# The .exe returned by Process.Start may be a lightweight jpackage launcher
# with a separate JVM child. Never equate the launcher with the server runtime.
# Process IDs, command lines, addresses and the disposable port numbers are
# used only within CI validation; none appear in saved telemetry.
function ResolveListenerJvm([System.Diagnostics.Process]$Launcher, [int[]]$Ports) {
    Check (-not $Launcher.HasExited) "R14k packaged launcher exited before observation"
    $owners = @()
    foreach ($port in $Ports) {
        $socket = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
            Where-Object { $_.LocalAddress -eq "127.0.0.1" })
        Check ($socket.Count -eq 1) "R14k expected one localhost listener per configured port"
        $owners += [int]$socket[0].OwningProcess
    }
    $pids = @($owners | Select-Object -Unique)
    Check ($pids.Count -eq 1 -and $pids[0] -gt 0) "R14k listeners must share one JVM process"
    $ownerPid = [int]$pids[0]

    # Windows reports the owning PID, not necessarily Process.Start's PID.
    # Accept only the original launcher or a proven descendant, and ensure
    # the listener executable belongs to the packaged application image.
    $currentPid = $ownerPid
    $isDescendant = $false
    for ($depth = 0; $depth -lt 16 -and $currentPid -gt 0; $depth++) {
        if ($currentPid -eq $Launcher.Id) {
            $isDescendant = $true
            break
        }
        $node = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction Stop
        Check ($null -ne $node) "R14k listener process lineage disappeared"
        $parentPid = [int]$node.ParentProcessId
        Check ($parentPid -ne $currentPid) "R14k cyclic process ancestry"
        $currentPid = $parentPid
    }
    Check $isDescendant "R14k listener owner is unrelated to packaged launcher"
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
    Check ($null -ne $info -and -not [string]::IsNullOrWhiteSpace($info.ExecutablePath)) "R14k listener executable not found"
    $imagePath = [IO.Path]::GetFullPath([string]$info.ExecutablePath)
    $packagePrefix = [IO.Path]::GetFullPath($AppRoot).TrimEnd('\') + '\'
    Check ($imagePath.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase)) "R14k listener runs outside packaged app image"

    $runtime = [System.Diagnostics.Process]::GetProcessById($ownerPid)
    try {
        $jvm = @($runtime.Modules | Where-Object { $_.ModuleName -ieq "jvm.dll" })
        Check ($jvm.Count -gt 0) "R14k listener owner did not load bundled JVM"
        $runtime.Refresh()
        return $runtime
    } catch {
        $runtime.Dispose()
        throw
    }
}

$script:TelemetrySamples = [System.Collections.Generic.List[object]]::new()
function RecordProcessSample([System.Diagnostics.Process]$Process, [int]$Launch, [string]$Phase, [int[]]$Ports) {
    if ([string]::IsNullOrWhiteSpace($TelemetryPath)) { return }
    Check (-not $Process.HasExited) "R14k process exited before resource sampling"
    $runtime = ResolveListenerJvm $Process $Ports
    try {
        $script:TelemetrySamples.Add([ordered]@{
            launch = $Launch
            phase = $Phase
            workingSetBytes = [long]$runtime.WorkingSet64
            privateBytes = [long]$runtime.PrivateMemorySize64
            threadCount = [int]$runtime.Threads.Count
            handleCount = [int]$runtime.HandleCount
            cpuMs = [Math]::Round($runtime.TotalProcessorTime.TotalMilliseconds, 2)
        })
    } finally {
        $runtime.Dispose()
    }
}
function WriteProcessTelemetry {
    if ([string]::IsNullOrWhiteSpace($TelemetryPath)) { return }
    Check ($script:TelemetrySamples.Count -eq 4) "R14k expected four live EXE resource samples"
    $report = [ordered]@{
        kind = "packaged-process-telemetry"
        schemaVersion = 2
        process = "packaged-windows-listener-jvm"
        listenerOwnerVerified = $true
        jvmModuleVerified = $true
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

# R14l: bounded HTTP/SQLite workload against the SAME packaged JVM and
# same persisted room across restart. This does not simulate WebSocket clients.
$script:LoadSamples = [System.Collections.Generic.List[object]]::new()
function RunPackagedHttpLoad(
    [System.Diagnostics.Process]$Launcher, [int]$Launch,
    [string]$Api, [string]$Listing, [hashtable]$Headers,
    [string]$RoomCode, [string]$OriginalMessage,
    [int[]]$Ports, [int]$Rounds
) {
    if ($Rounds -eq 0) { return }
    for ($round = 1; $round -le $Rounds; $round++) {
        Check (-not $Launcher.HasExited) "R14l packaged app exited during HTTP load"
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $directory = Invoke-RestMethod -Uri $Listing -Method Get -TimeoutSec 10
        Check (@($directory.rooms | Where-Object { $_.roomCode -eq $RoomCode }).Count -eq 1) "R14l hosted room directory invariant failed"
        $member = Invoke-RestMethod -Uri "$Api/me" -Method Get -Headers $Headers -TimeoutSec 10
        Check ($member.room.roomCode -eq $RoomCode) "R14l bearer membership was not durable"
        $writes = 0
        $latestMessage = $OriginalMessage
        # Four real committed chat events per process at 24 rounds, paced
        # to stay well below production anti-abuse rate limits.
        if ($round % 6 -eq 0) {
            $latestMessage = ('r14lLoadL{0}R{1}' -f $Launch,$round)
            $body = @{ messageId = $latestMessage; text = "R14l bounded test message" } | ConvertTo-Json -Compress
            $posted = Invoke-RestMethod -Uri "$Api/chat" -Method Post -Headers $Headers -ContentType "application/json" -Body $body -TimeoutSec 10
            Check ($posted.messageId -eq $latestMessage) "R14l new chat write failed"
            $writes = 1
        }
        $chat = Invoke-RestMethod -Uri "$Api/chat?after=-1" -Method Get -Headers $Headers -TimeoutSec 10
        Check (@($chat.messages | Where-Object { $_.messageId -eq $OriginalMessage }).Count -eq 1) "R14l original chat disappeared"
        Check (@($chat.messages | Where-Object { $_.messageId -eq $latestMessage }).Count -eq 1) "R14l committed chat not readable"
        $timer.Stop()
        $jvm = ResolveListenerJvm $Launcher $Ports
        try {
            $script:LoadSamples.Add([ordered]@{
                launch = $Launch
                round = $round
                elapsedMs = [Math]::Round($timer.Elapsed.TotalMilliseconds, 2)
                requests = 3 + $writes
                writes = $writes
                workingSetBytes = [long]$jvm.WorkingSet64
                privateBytes = [long]$jvm.PrivateMemorySize64
                threadCount = [int]$jvm.Threads.Count
                handleCount = [int]$jvm.HandleCount
                cpuMs = [Math]::Round($jvm.TotalProcessorTime.TotalMilliseconds, 2)
            })
        } finally {
            $jvm.Dispose()
        }
        Start-Sleep -Milliseconds 120
    }
}
function WriteLoadTelemetry {
    if ($LoadRounds -eq 0) { return }
    Check ($script:LoadSamples.Count -eq (2 * $LoadRounds)) "R14l missing process load samples"
    $report = [ordered]@{
        kind = "packaged-http-soak"
        schemaVersion = 1
        source = "packaged-windows-listener-jvm"
        roundsPerLaunch = $LoadRounds
        listenerOwnerVerified = $true
        jvmModuleVerified = $true
        verifiedRestarts = 1
        verifiedGracefulExits = 2
        portsReleased = $true
        roomRecovered = $true
        samples = @($script:LoadSamples.ToArray())
    }
    $stream = [IO.File]::Open($LoadReportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        try { $writer.WriteLine(($report | ConvertTo-Json -Depth 8 -Compress)) }
        finally { $writer.Dispose() }
    } finally { $stream.Dispose() }
}

# R14m: create independent, genuine spectator identities and socket sessions
# against the actual packaged Java listener. The Node child receives the
# temporary host credential only through inherited environment, never args.
# Node's per-launch scratch output is inside the disposable fixture root.
$script:WsRunRecords = [System.Collections.Generic.List[object]]::new()
$script:WsSoakRecords = [System.Collections.Generic.List[object]]::new()
function MeasurePackagedJvm([System.Diagnostics.Process]$Launcher, [int[]]$Ports) {
    $jvm = ResolveListenerJvm $Launcher $Ports
    try {
        return [ordered]@{
            workingSetBytes = [long]$jvm.WorkingSet64
            privateBytes = [long]$jvm.PrivateMemorySize64
            threadCount = [int]$jvm.Threads.Count
            handleCount = [int]$jvm.HandleCount
            cpuMs = [Math]::Round($jvm.TotalProcessorTime.TotalMilliseconds, 2)
        }
    } finally { $jvm.Dispose() }
}
function RunPackagedWsFanout(
    [System.Diagnostics.Process]$Launcher, [int]$Launch,
    [string]$HostToken, [string]$RoomCode, [string]$RoomId,
    [string]$Root, [int[]]$Ports
) {
    if ($WsSpectators -eq 0) { return }
    Check (-not $Launcher.HasExited) "R14m packaged listener exited"
    $start = MeasurePackagedJvm $Launcher $Ports
    $scratch = Join-Path $Root ("r14m-ws-" + $Launch + ".json")
    $keys = @(
        "BGP_R14M_LAUNCH","BGP_R14M_SPECTATORS","BGP_R14M_HTTP_PORT",
        "BGP_R14M_WS_PORT","BGP_R14M_ROOM_CODE","BGP_R14M_ROOM_ID",
        "BGP_R14M_HOST_TOKEN"
    )
    $values = @{
        BGP_R14M_LAUNCH = [string]$Launch
        BGP_R14M_SPECTATORS = [string]$WsSpectators
        BGP_R14M_HTTP_PORT = [string]$Ports[2]
        BGP_R14M_WS_PORT = [string]$Ports[1]
        BGP_R14M_ROOM_CODE = $RoomCode
        BGP_R14M_ROOM_ID = $RoomId
        BGP_R14M_HOST_TOKEN = $HostToken
    }
    if ($WsSoakCycles -gt 0) {
        # R14n: run the existing client asynchronously. While it repeatedly
        # authenticates spectators and replays chat, the parent samples ONLY
        # the actual packaged listener-JVM. A separate disposable report
        # holds per-cycle counts, not credentials.
        $soakScratch = Join-Path $Root ("r14n-ws-" + $Launch + ".json")
        $info = [Diagnostics.ProcessStartInfo]::new()
        $info.FileName = "node"
        $info.WorkingDirectory = $ServerRoot
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.ArgumentList.Add((Join-Path $ServerRoot "smoke-packaged-websocket-fanout.mjs"))
        $info.ArgumentList.Add("--report=$scratch")
        $info.ArgumentList.Add("--cycles=$WsSoakCycles")
        $info.ArgumentList.Add("--pause-ms=6000")
        $info.ArgumentList.Add("--soak-report=$soakScratch")
        foreach ($key in $values.Keys) { $info.Environment[$key] = $values[$key] }
        $child = [Diagnostics.Process]::Start($info)
        Check ($null -ne $child) "R14n spectator worker could not start"
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $samples = [System.Collections.Generic.List[object]]::new()
        try {
            $snapshot = MeasurePackagedJvm $Launcher $Ports
            $samples.Add([ordered]@{elapsedMs=0; counters=$snapshot})
            while (-not $child.WaitForExit(5000)) {
                Check (-not $Launcher.HasExited) "R14n packaged JVM exited under sustained spectators"
                if ($watch.Elapsed.TotalSeconds -gt 240) {
                    throw "R14n bounded spectator worker exceeded 4-minute safety limit"
                }
                $snapshot = MeasurePackagedJvm $Launcher $Ports
                $samples.Add([ordered]@{
                    elapsedMs = [Math]::Round($watch.Elapsed.TotalMilliseconds,2)
                    counters = $snapshot
                })
            }
            Check ($child.ExitCode -eq 0) "R14n actual packaged spectator cycle failed"
            $snapshot = MeasurePackagedJvm $Launcher $Ports
            $samples.Add([ordered]@{
                elapsedMs = [Math]::Round($watch.Elapsed.TotalMilliseconds,2)
                counters = $snapshot
            })
            Write-Host $child.StandardOutput.ReadToEnd().Trim()
        } finally {
            if (-not $child.HasExited) {
                $child.Kill($true)
                [void]$child.WaitForExit(12000)
            }
            $child.Dispose()
        }
        $soak = Get-Content -LiteralPath $soakScratch -Raw -Encoding utf8 | ConvertFrom-Json
        Check ($soak.kind -eq "packaged-ws-duration-client" -and
            $soak.launch -eq $Launch -and $soak.cycles -eq $WsSoakCycles -and
            $soak.spectators -eq 12) "R14n client cycle report incomplete"
        $script:WsSoakRecords.Add([ordered]@{
            launch = $Launch
            cycles = [int]$soak.cycles
            pauseMs = [int]$soak.pauseMs
            durationMs = [double]$soak.durationMs
            spectators = [int]$soak.spectators
            handshakes = [int]$soak.handshakes
            liveEvents = [int]$soak.liveEvents
            replayEvents = [int]$soak.replayEvents
            cleanCloses = [int]$soak.cleanCloses
            cycleResults = @($soak.cycleResults)
            samples = @($samples.ToArray())
        })
    } else {
        try {
            foreach ($key in $values.Keys) { Set-Item -Path "Env:$key" -Value $values[$key] }
            node (Join-Path $ServerRoot "smoke-packaged-websocket-fanout.mjs") "--report=$scratch"
            Check ($LASTEXITCODE -eq 0) "R14m real packaged WS fanout failed"
        } finally {
            foreach ($key in $keys) {
                Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue
            }
        }
    }
    $client = Get-Content -LiteralPath $scratch -Raw -Encoding utf8 | ConvertFrom-Json
    Check ($client.kind -eq "packaged-ws-client" -and
        $client.launch -eq $Launch -and
        $client.spectators -eq $WsSpectators) "R14m client report not completed"
    $end = MeasurePackagedJvm $Launcher $Ports
    $script:WsRunRecords.Add([ordered]@{
        launch = $Launch
        spectators = [int]$client.spectators
        joined = [int]$client.joined
        handshakes = [int]$client.handshakes
        snapshots = [int]$client.snapshots
        liveEvents = [int]$client.liveEvents
        replayEvents = [int]$client.replayEvents
        cleanCloses = [int]$client.cleanCloses
        liveSequenceBeforeReplay = [bool]$client.liveSequenceBeforeReplay
        elapsedMs = [double]$client.elapsedMs
        before = $start
        after = $end
    })
}
function WriteWsDurationReport {
    if ($WsSoakCycles -eq 0) { return }
    Check ($script:WsSoakRecords.Count -eq 2) "R14n expected two complete packaged JVM traces"
    $report = [ordered]@{
        kind = "packaged-ws-duration"
        schemaVersion = 1
        source = "packaged-windows-listener-jvm"
        cyclesPerLaunch = $WsSoakCycles
        spectatorsPerLaunch = 12
        sampleIntervalMs = 5000
        listenerOwnerVerified = $true
        jvmModuleVerified = $true
        verifiedRestarts = 1
        verifiedGracefulExits = 2
        portsReleased = $true
        roomRecovered = $true
        launches = @($script:WsSoakRecords.ToArray())
    }
    $stream = [IO.File]::Open($WsSoakReportPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $writer = [IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false))
        try { $writer.WriteLine(($report | ConvertTo-Json -Depth 10 -Compress)) }
        finally { $writer.Dispose() }
    } finally { $stream.Dispose() }
}
function WriteWsFanoutReport {
    if ($WsSpectators -eq 0) { return }
    Check ($script:WsRunRecords.Count -eq 2) "R14m two packaged JVM socket lifecycles required"
    $result = [ordered]@{
        kind = "packaged-ws-fanout"
        schemaVersion = 1
        source = "packaged-windows-listener-jvm"
        spectatorsPerLaunch = $WsSpectators
        verifiedRestarts = 1
        verifiedGracefulExits = 2
        listenerOwnerVerified = $true
        jvmModuleVerified = $true
        portsReleased = $true
        roomRecovered = $true
        launches = @($script:WsRunRecords.ToArray())
    }
    $stream = [IO.File]::Open($WsReportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        try { $writer.WriteLine(($result | ConvertTo-Json -Depth 9 -Compress)) }
        finally { $writer.Dispose() }
    } finally { $stream.Dispose() }
}
# R14r: independent two-player Yacht room inside the SAME real packaged
# Windows JVM fixture, separate from R14m's spectator-only fanout room.
$script:YachtContext = $null
$script:YachtObservations = [System.Collections.Generic.List[object]]::new()
function YachtApi([string]$Api,[string]$Path,[string]$Token,
    [string]$Method="GET",[object]$Body=$null) {
    $headers = @{ Authorization = "Bearer $Token" }
    if ($Method -eq "POST") {
        $headers.Origin = $Api.Substring(0,$Api.IndexOf("/api/"))
        return Invoke-RestMethod -Method Post -Uri "$Api$Path" -Headers $headers -ContentType "application/json" -Body ($Body | ConvertTo-Json -Compress -Depth 8) -TimeoutSec 12
    }
    return Invoke-RestMethod -Method Get -Uri "$Api$Path" -Headers $headers -TimeoutSec 12
}
function RunPackagedYacht([int]$Launch,[string]$Api,[string]$Origin) {
    if (-not $YachtReportPath) { return }
    if ($Launch -eq 1) {
        $hosted = Invoke-RestMethod -Method Post -Uri "$Api/public/hosted" -Headers @{Origin=$Origin} -ContentType "application/json" -Body (@{gameId="yacht";name="R14r packaged two-player match";displayName="R14r first player";hostSeat="PLAYER";maxPlayers=2;maxRoomMembers=4} | ConvertTo-Json -Compress) -TimeoutSec 12
        $joined = Invoke-RestMethod -Method Post -Uri "$Api/public/join" -Headers @{Origin=$Origin} -ContentType "application/json" -Body (@{gameId="yacht";roomCode=[string]$hosted.room.roomCode;displayName="R14r second player";seatRole="PLAYER"} | ConvertTo-Json -Compress) -TimeoutSec 12
        Check ($hosted.memberId -ne $joined.memberId -and $hosted.room.roomId -eq $joined.room.roomId) "R14r two independent players required"
        $script:YachtContext = @{ HostToken=[string]$hosted.token;GuestToken=[string]$joined.token;HostId=[string]$hosted.memberId;GuestId=[string]$joined.memberId }
        $ctx = $script:YachtContext
        [void](YachtApi $Api "/me/ready" $ctx.HostToken "POST" @{ready=$true})
        [void](YachtApi $Api "/me/ready" $ctx.GuestToken "POST" @{ready=$true})
        $started = YachtApi $Api "/yacht/start" $ctx.HostToken "POST" @{}
        Check ($started.room.state -eq "PLAYING" -and $started.yacht.match.phase -eq "ACTIVE" -and $started.yacht.match.completedTurns -eq 0) "R14r Yacht start did not commit"
        $state = YachtApi $Api "/yacht" $ctx.HostToken
        Check ($state.memberId -eq $ctx.HostId -and $state.currentPlayer -eq $true) "R14r wrong active host"
        $rolled = YachtApi $Api "/yacht/roll" $ctx.HostToken "POST" @{commandId="r14r-first-roll";expectedVersion=[long]$state.yacht.match.version}
        Check ($rolled.yacht.match.rolls -eq 1 -and $rolled.yacht.match.version -gt $state.yacht.match.version -and @($rolled.yacht.match.dice).Count -eq 5) "R14r first dice roll did not commit"
        $ctx.MatchId=[string]$rolled.yacht.match.id
        $ctx.VersionBeforeRestart=[long]$rolled.yacht.match.version
        $ctx.DiceBeforeRestart=(@($rolled.yacht.match.dice) -join ",")
        $chat=YachtApi $Api "/chat" $ctx.GuestToken "POST" @{messageId="r14rGuestBeforeRestart";text="R14r two-player guest chat"}
        Check ($chat.messageId -eq "r14rGuestBeforeRestart" -and [long]$chat.sequence -ge 0) "R14r guest chat not committed"
        $ctx.ChatSequence=[long]$chat.sequence
        $script:YachtObservations.Add([ordered]@{launch=1;players=2;rolls=1;completedTurns=0;chatCommitted=$true;matchVersion=[long]$rolled.yacht.match.version})
        Write-Host "GAME_ROOM_R14R_PACKAGED_YACHT_STAGE_PASSED stage=before-restart"
    } else {
        $ctx=$script:YachtContext
        Check ($null -ne $ctx) "R14r missing first-launch game context"
        $hostState=YachtApi $Api "/yacht" $ctx.HostToken
        $guest=YachtApi $Api "/yacht" $ctx.GuestToken
        Check ($hostState.memberId -eq $ctx.HostId -and $guest.memberId -eq $ctx.GuestId -and $hostState.yacht.match.id -eq $ctx.MatchId -and $hostState.yacht.match.version -eq $ctx.VersionBeforeRestart -and $hostState.yacht.match.rolls -eq 1 -and $hostState.yacht.match.phase -eq "ACTIVE" -and $hostState.room.state -eq "PLAYING" -and (@($hostState.yacht.match.dice) -join ",") -eq $ctx.DiceBeforeRestart) "R14r Yacht ID/version/dice did not survive packaged JVM restart"
        $history=YachtApi $Api "/chat?after=-1" $ctx.GuestToken
        Check (@($history.messages | Where-Object { $_.messageId -eq "r14rGuestBeforeRestart" -and [long]$_.sequence -eq $ctx.ChatSequence }).Count -eq 1) "R14r guest chat did not survive restart"
        $scored=YachtApi $Api "/yacht/score" $ctx.HostToken "POST" @{commandId="r14r-host-score";expectedVersion=[long]$hostState.yacht.match.version;category="chance"}
        Check ($scored.yacht.match.completedTurns -eq 1 -and $scored.yacht.match.currentPlayer -eq 1 -and $scored.yacht.match.version -gt $ctx.VersionBeforeRestart) "R14r score did not rotate turn"
        $next=YachtApi $Api "/yacht" $ctx.GuestToken
        Check ($next.currentPlayer -eq $true -and $next.memberId -eq $ctx.GuestId) "R14r guest not active after score"
        $guestRoll=YachtApi $Api "/yacht/roll" $ctx.GuestToken "POST" @{commandId="r14r-guest-roll";expectedVersion=[long]$next.yacht.match.version}
        Check ($guestRoll.yacht.match.completedTurns -eq 1 -and $guestRoll.yacht.match.rolls -eq 1 -and $guestRoll.yacht.match.version -gt $next.yacht.match.version) "R14r guest could not continue match"
        $script:YachtObservations.Add([ordered]@{launch=2;players=2;rolls=1;completedTurns=1;chatRecovered=$true;matchIdRecovered=$true;diceRecovered=$true;versionRecovered=$true;turnRotated=$true;guestRollCommitted=$true})
        Write-Host "GAME_ROOM_R14R_PACKAGED_YACHT_STAGE_PASSED stage=after-restart"
    }
}
function WriteYachtRecoveryReport {
    if (-not $YachtReportPath) { return }
    Check ($script:YachtObservations.Count -eq 2) "R14r missing two observations"
    $result=[ordered]@{kind="packaged-yacht-chat-recovery";schemaVersion=1;source="packaged-windows-listener-jvm";players=2;verifiedRestarts=1;verifiedGracefulExits=2;portsReleased=$true;listenerOwnerVerified=$true;jvmModuleVerified=$true;observations=@($script:YachtObservations.ToArray())}
    $stream=[IO.File]::Open($YachtReportPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $writer=[IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false))
        try {$writer.WriteLine(($result | ConvertTo-Json -Depth 9 -Compress))}
        finally {$writer.Dispose()}
    } finally {$stream.Dispose()}
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
    RecordProcessSample $Process 1 "ready" @($adminPort,$wsPort,$clientPort)
    $roomCapacity = if ($WsSpectators -gt 0) { 26 } else { 4 }
    $body = @{gameId="yacht";name="R14e packaged persistent room";displayName="R14e host";hostSeat="PLAYER";maxPlayers=2;maxRoomMembers=$roomCapacity} | ConvertTo-Json -Compress
    $hosted = Invoke-RestMethod -Method Post -Uri "$api/public/hosted" -Headers $originHeaders -ContentType "application/json" -Body $body -TimeoutSec 10
    Check (-not [string]::IsNullOrEmpty($hosted.token)) "real anonymous host bearer issued"
    $Checks++
    $token = [string]$hosted.token
    $code = [string]$hosted.room.roomCode
    $roomId = [string]$hosted.room.roomId
    Check ($code.Length -eq 6) "real hosted room code"
    $Checks++
    $messageId = "r14ePackagedMessage1"
    $chatBody = @{messageId=$messageId;text="R14e durable chat"} | ConvertTo-Json -Compress
    $headers = @{ Authorization = "Bearer $token"; Origin = "http://127.0.0.1:$clientPort" }
    $posted = Invoke-RestMethod -Method Post -Uri "$api/chat" -Headers $headers -ContentType "application/json" -Body $chatBody -TimeoutSec 10
    Check ($posted.messageId -eq $messageId) "chat was persisted before restart"
    $Checks++
    RecordProcessSample $Process 1 "afterChat" @($adminPort,$wsPort,$clientPort)
    RunPackagedHttpLoad $Process 1 $api $listing $headers $code $messageId @($adminPort,$wsPort,$clientPort) $LoadRounds
    RunPackagedWsFanout $Process 1 $token $code $roomId $FixtureRoot @($adminPort,$wsPort,$clientPort)
    RunPackagedYacht 1 $api "http://127.0.0.1:$clientPort"
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
    RecordProcessSample $Process 2 "ready" @($adminPort,$wsPort,$clientPort)
    $me = Invoke-RestMethod -Method Get -Uri "$api/me" -Headers $headers -TimeoutSec 10
    Check ($me.room.roomCode -eq $code) "original member session survives restart"
    $Checks++
    $messages = Invoke-RestMethod -Method Get -Uri "$api/chat?after=-1" -Headers $headers -TimeoutSec 10
    Check (@($messages.messages | Where-Object { $_.messageId -eq $messageId }).Count -eq 1) "durable room chat survives restart"
    $Checks++
    RecordProcessSample $Process 2 "afterReplay" @($adminPort,$wsPort,$clientPort)
    RunPackagedHttpLoad $Process 2 $api $listing $headers $code $messageId @($adminPort,$wsPort,$clientPort) $LoadRounds
    RunPackagedWsFanout $Process 2 $token $code $roomId $FixtureRoot @($adminPort,$wsPort,$clientPort)
    RunPackagedYacht 2 $api "http://127.0.0.1:$clientPort"
    Check (-not $Process.HasExited) "restarted Windows app remains running"
    $Checks++
    if ($StopMode -eq "Graceful") {
        RequestGracefulStop $Process $FixtureRoot @($adminPort,$wsPort,$clientPort)
        $Process = $null
        $Checks += 5
        WriteProcessTelemetry
        WriteLoadTelemetry
        WriteWsFanoutReport
        WriteWsDurationReport
        WriteYachtRecoveryReport
        if ($YachtReportPath) { Write-Host "GAME_ROOM_R14R_PACKAGED_YACHT_RECOVERY_PASSED players=2 rolls=2 chatRecovered=true restarts=1" }
        if ($WsSoakCycles -gt 0) { Write-Host "GAME_ROOM_R14N_PACKAGED_WS_DURATION_PASSED launches=2 cyclesPerLaunch=6 spectators=12" }
        if ($WsSpectators -gt 0) { Write-Host "GAME_ROOM_R14M_PACKAGED_WS_FANOUT_PASSED launches=2 spectators=12 liveEvents=24 replayEvents=24" }
        if ($LoadRounds -gt 0) { Write-Host "GAME_ROOM_R14L_PACKAGED_HTTP_SOAK_PASSED roundsPerLaunch=$LoadRounds restarts=1 gracefulExits=2" }
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
