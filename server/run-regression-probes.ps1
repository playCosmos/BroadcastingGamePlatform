param(
    [string]$Jar = "target/broadcasting-game-platform-server-0.1.0-SNAPSHOT.jar"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Jar)) {
    throw "platform regression jar missing: $Jar"
}

$MainClasses = "target/classes"
$TestClasses = "target/test-classes"
$Dependencies = "target/probe-dependencies/*"
if (-not (Test-Path $MainClasses)) {
    throw "platform regression main classes missing: $MainClasses"
}
if (-not (Test-Path $TestClasses)) {
    throw "platform regression test classes missing: $TestClasses"
}
if (-not (Test-Path "target/probe-dependencies")) {
    throw "platform regression dependencies missing"
}
$ClassPath = $TestClasses + [IO.Path]::PathSeparator + $MainClasses + [IO.Path]::PathSeparator + $Dependencies

$Probes = @(
    "io.github.playcosmos.broadcastinggameplatform.platform.events.PlatformEventBusProbe",
    "io.github.playcosmos.broadcastinggameplatform.operations.FileLogProbe",
    "io.github.playcosmos.broadcastinggameplatform.operations.BoundedVirtualThreadExecutorProbe",
    "io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw.ViewerDrawProbe",
    "io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw.ViewerDrawMapProbe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomR1Probe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomR2Probe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomR3Probe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.GameRoomR3TransportProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.GameRoomYachtR4HttpProbe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomDrawingR5Probe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomBroadcastR12Probe",
    "io.github.playcosmos.broadcastinggameplatform.platform.provider.SoopMultiProviderR12bProbe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomBroadcastGrantR12cProbe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomBroadcastGrantR12dProbe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomStreamerRotationR13aProbe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomTelephoneR13bProbe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomTelephoneCoopR13cProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.GameRoomDrawingR5HttpProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.GameRoomDrawingR5TransportProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.GameRoomHttpR2Probe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.GameRoomPublicAdmissionProbe",
    "io.github.playcosmos.broadcastinggameplatform.platform.rooms.GameRoomPublicLifecycleProbe",
    "io.github.playcosmos.broadcastinggameplatform.games.yacht.YachtScoringProbe",
    "io.github.playcosmos.broadcastinggameplatform.games.yacht.YachtPersistenceProbe",
    "io.github.playcosmos.broadcastinggameplatform.games.yacht.YachtRoomProbe",
    "io.github.playcosmos.broadcastinggameplatform.games.yacht.YachtV30MigrationProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.YachtHttpApiProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.YachtWebSocketProbe",
    "io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingSyncProbe",
    "io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingGuessCoreProbe",
    "io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingGuessPersistenceProbe",
    "io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingGuessChatProbe",
    "io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingGuessOverlayStateProbe",
    "io.github.playcosmos.broadcastinggameplatform.games.drawingguess.DrawingGuessRecoveryProbe",
    "io.github.playcosmos.broadcastinggameplatform.room.RoomProbe",
    "io.github.playcosmos.broadcastinggameplatform.room.BoardGameRuntimeProbe",
    "io.github.playcosmos.broadcastinggameplatform.room.MixedMovementProbe",
    "io.github.playcosmos.broadcastinggameplatform.room.RoomOperationProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.ClientBoundaryProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.ServerManagementProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.AdminAuthPersistenceProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameDatabaseBackupProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.BoardGameWebSocketRateProbe",
    "io.github.playcosmos.broadcastinggameplatform.boardserver.BoardServerConfigPersistenceProbe"
)

foreach ($Probe in $Probes) {
    Write-Host "[probe] $Probe"
    java -cp $ClassPath $Probe
    if ($LASTEXITCODE -ne 0) {
        throw "platform regression probe failed: $Probe ($LASTEXITCODE)"
    }
}

Write-Host "[probe] PlatformServerMain --board-server-probe"
java -cp $ClassPath io.github.playcosmos.broadcastinggameplatform.boardserver.PlatformServerMain --board-server-probe
if ($LASTEXITCODE -ne 0) {
    throw "platform server probe failed: $LASTEXITCODE"
}

Write-Host "[probe] all platform regression probes passed"
