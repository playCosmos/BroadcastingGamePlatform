param(
    [Parameter(Mandatory=$true)]
    [string]$AppRoot,
    [Parameter(Mandatory=$true)]
    [ValidateCount(3,3)]
    [int[]]$ListenerPorts,
    [Parameter(Mandatory=$true)]
    [string]$OutputPath,
    [ValidateRange(60,259200)]
    [int]$DurationSeconds = 86400,
    [ValidateRange(5,3600)]
    [int]$IntervalSeconds = 60
)
# R14o: read-only field observation of an ALREADY RUNNING packaged Windows
# server. Does not start, stop, restart or configure any production process.
# A failed/interrupted run has NO completion footer and MUST fail analysis.
$ErrorActionPreference = "Stop"
if (-not $IsWindows) { throw "R14o requires Windows PowerShell 7+" }
if ($ListenerPorts.Count -ne 3 -or @($ListenerPorts | Select-Object -Unique).Count -ne 3 -or
    @($ListenerPorts | Where-Object { $_ -lt 1 -or $_ -gt 65535 }).Count -gt 0) {
    throw "R14o requires three distinct valid local listening ports"
}
if ($IntervalSeconds -ge $DurationSeconds) {
    throw "R14o interval must be shorter than duration"
}
$root = [IO.Path]::GetFullPath($AppRoot).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
$exe = Join-Path $root "BroadcastingGamePlatformServer.exe"
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "R14o requires the actual installed/extracted Windows app-image root"
}
$path = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $path) { throw "R14o report must be a new file" }
$expected = [int][Math]::Ceiling($DurationSeconds / [double]$IntervalSeconds) + 1

function Require([bool]$ok,[string]$message) {
    if (-not $ok) { throw "R14o field observation: $message" }
}
function ReadListenerJvm {
    # The launcher PID is NOT a reliable resource source (jpackage may have
    # a separate JVM child). Resolve all actual configured listener owners.
    $owners = [System.Collections.Generic.List[int]]::new()
    foreach ($port in $ListenerPorts) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
        Require ($listeners.Count -ge 1) "configured listener unavailable"
        $perPort = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
        Require ($perPort.Count -eq 1 -and [int]$perPort[0] -gt 0) "ambiguous listener owner"
        $owners.Add([int]$perPort[0])
    }
    $uniqueOwners = @($owners | Select-Object -Unique)
    Require ($uniqueOwners.Count -eq 1) "listeners are not owned by one JVM"
    $ownerPid = [int]$uniqueOwners[0]
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
    Require ($null -ne $info -and -not [string]::IsNullOrWhiteSpace($info.ExecutablePath)) "listener executable unavailable"
    $image = [IO.Path]::GetFullPath([string]$info.ExecutablePath)
    Require ($image.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) "listener is outside the selected package"
    $jvm = [Diagnostics.Process]::GetProcessById($ownerPid)
    try {
        $loaded = @($jvm.Modules | Where-Object { $_.ModuleName -ieq "jvm.dll" })
        Require ($loaded.Count -ge 1) "listener does not own a loaded JVM"
        $jvm.Refresh()
        Require (-not $jvm.HasExited) "JVM exited before observation"
        return $jvm
    } catch {
        $jvm.Dispose()
        throw
    }
}
function ReadCounters([Diagnostics.Process]$jvm) {
    return [ordered]@{
        workingSetBytes = [long]$jvm.WorkingSet64
        privateBytes = [long]$jvm.PrivateMemorySize64
        threadCount = [int]$jvm.Threads.Count
        handleCount = [int]$jvm.HandleCount
        cpuMs = [Math]::Round($jvm.TotalProcessorTime.TotalMilliseconds,2)
    }
}
function WriteRecord([IO.StreamWriter]$writer,[object]$value) {
    $writer.WriteLine(($value | ConvertTo-Json -Depth 6 -Compress))
    $writer.Flush()
}

# Check identity BEFORE creating output. Never persist PID, executable path,
# ports, credentials, chat content, IPs or other machine-identifying details.
$initial = ReadListenerJvm
$initialPid = $initial.Id
$initialStarted = [long]$initial.StartTime.ToUniversalTime().Ticks
$initial.Dispose()
$stream = [IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
$writer = [IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false))
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
    WriteRecord $writer ([ordered]@{
        kind = "field-jvm-duration"
        schemaVersion = 1
        source = "packaged-windows-listener-jvm"
        durationSeconds = $DurationSeconds
        intervalSeconds = $IntervalSeconds
        expectedSamples = $expected
        listenerOwnerVerified = $true
        jvmModuleVerified = $true
    })
    for ($i = 0; $i -lt $expected; $i++) {
        $target = [Math]::Min([double]$DurationSeconds,[double]$i * $IntervalSeconds)
        while ($clock.Elapsed.TotalSeconds -lt $target) {
            Start-Sleep -Milliseconds ([int][Math]::Min(1000,
                [Math]::Max(1,($target - $clock.Elapsed.TotalSeconds)*1000)))
        }
        $jvm = ReadListenerJvm
        try {
            Require (($jvm.Id -eq $initialPid) -and
                ([long]$jvm.StartTime.ToUniversalTime().Ticks -eq $initialStarted)) "packaged JVM identity changed during observation"
            $counters = ReadCounters $jvm
        } finally { $jvm.Dispose() }
        WriteRecord $writer ([ordered]@{
            kind = "sample"
            index = $i
            elapsedSeconds = [Math]::Round($clock.Elapsed.TotalSeconds,3)
            observedUtc = [DateTimeOffset]::UtcNow.ToString("o")
            counters = $counters
        })
        if ($i -eq 0 -or ($i + 1) % 60 -eq 0 -or ($i + 1) -eq $expected) {
            Write-Host ("R14o samples={0}/{1}, elapsedHours={2:N2}" -f
                ($i + 1),$expected,($clock.Elapsed.TotalHours))
        }
    }
    # Completion exists ONLY after every observation, exact same JVM, and
    # elapsed duration. Interrupted runs remain usable for diagnosis but
    # cannot be accidentally reported as successful acceptance.
    Require ($clock.Elapsed.TotalSeconds -ge $DurationSeconds) "duration ended prematurely"
    WriteRecord $writer ([ordered]@{
        kind = "complete"
        observedSamples = $expected
        completedDurationSeconds = [Math]::Round($clock.Elapsed.TotalSeconds,3)
        sameJvmThroughout = $true
        listenerOwnerVerified = $true
        jvmModuleVerified = $true
    })
    Write-Host "GAME_ROOM_R14O_FIELD_SAMPLER_COMPLETED samples=$expected"
} finally {
    $writer.Dispose()
    $stream.Dispose()
}
