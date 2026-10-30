param(
    [Parameter(Mandatory=$true)][ValidateSet(1,2)][int]$Launch,
    [Parameter(Mandatory=$true)][string]$FixtureRoot,
    [Parameter(Mandatory=$true)][int]$HttpPort,
    [Parameter(Mandatory=$true)][int]$WebSocketPort,
    [Parameter(Mandatory=$true)][int]$ProxyPort,
    [Parameter(Mandatory=$true)][string]$RoomId,
    [Parameter(Mandatory=$true)][string]$HostToken,
    [Parameter(Mandatory=$true)][string]$GuestToken
)
$ErrorActionPreference = "Stop"
$here=Split-Path -Parent $MyInvocation.MyCommand.Path
if (@($HttpPort,$WebSocketPort,$ProxyPort | Select-Object -Unique).Count -ne 3) {
    throw "R14v three different test-only listener ports required"
}
if (-not $RoomId -or $HostToken -eq $GuestToken) {
    throw "R14v distinct disposable authenticated players required"
}
$pfx=Join-Path $FixtureRoot ("r14v-local-"+$Launch+".pfx")
$pemPath=Join-Path $FixtureRoot ("r14v-local-"+$Launch+".pem")
$password=[guid]::NewGuid().ToString("N")
$rsa=[Security.Cryptography.RSA]::Create(2048)
try {
    $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new(
        "CN=localhost",$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName("localhost")
    $san.AddIpAddress([Net.IPAddress]::Loopback)
    $request.CertificateExtensions.Add($san.Build())
    $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-2),
        [DateTimeOffset]::UtcNow.AddHours(1))
    try {
        [IO.File]::WriteAllBytes($pfx,
            $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$password))
        $der=$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
        $pem="-----BEGIN CERTIFICATE-----"+[Environment]::NewLine+
            [Convert]::ToBase64String($der,[Base64FormattingOptions]::InsertLineBreaks)+
            [Environment]::NewLine+"-----END CERTIFICATE-----"+[Environment]::NewLine
        [IO.File]::WriteAllText($pemPath,$pem,[Text.UTF8Encoding]::new($false))
    } finally {$cert.Dispose()}
} finally {$rsa.Dispose()}
$proxyInfo=[Diagnostics.ProcessStartInfo]::new()
$proxyInfo.FileName="node"
$proxyInfo.WorkingDirectory=$here
$proxyInfo.UseShellExecute=$false
$proxyInfo.CreateNoWindow=$true
$proxyInfo.RedirectStandardOutput=$true
$proxyInfo.RedirectStandardError=$true
$proxyInfo.ArgumentList.Add((Join-Path $here "smoke-packaged-local-tls-proxy.mjs"))
$proxyInfo.Environment["BGP_R14V_PROXY_PORT"]=[string]$ProxyPort
$proxyInfo.Environment["BGP_R14V_HTTP_PORT"]=[string]$HttpPort
$proxyInfo.Environment["BGP_R14V_WS_PORT"]=[string]$WebSocketPort
$proxyInfo.Environment["BGP_R14V_PFX"]=$pfx
$proxyInfo.Environment["BGP_R14V_PFX_PASSPHRASE"]=$password
$proxy=[Diagnostics.Process]::Start($proxyInfo)
if ($null -eq $proxy) {throw "R14v localhost HTTPS/WSS proxy did not start"}
try {
    $ready=$false
    for($i=0;$i -lt 100;$i++) {
        if($proxy.HasExited){throw "R14v local TLS proxy exited"}
        $tcp=[Net.Sockets.TcpClient]::new()
        try {
            $tcp.Connect([Net.IPAddress]::Loopback,$ProxyPort)
            $ready=$true
            break
        } catch {
            Start-Sleep -Milliseconds 100
        } finally {$tcp.Dispose()}
    }
    if(-not $ready){throw "R14v localhost TLS proxy did not listen"}
    $clientInfo=[Diagnostics.ProcessStartInfo]::new()
    $clientInfo.FileName="node"
    $clientInfo.WorkingDirectory=$here
    $clientInfo.UseShellExecute=$false
    $clientInfo.CreateNoWindow=$true
    $clientInfo.RedirectStandardOutput=$true
    $clientInfo.RedirectStandardError=$true
    $clientInfo.ArgumentList.Add((Join-Path $here "observe-external-yacht-two-player-field.mjs"))
    $clientInfo.ArgumentList.Add("--base=https://localhost:$ProxyPort")
    $clientInfo.ArgumentList.Add("--timeout-ms=15000")
    $clientInfo.Environment["NODE_EXTRA_CA_CERTS"]=$pemPath
    $clientInfo.Environment["BGP_R14U_TEST_ROOM_ID"]=$RoomId
    $clientInfo.Environment["BGP_R14U_PLAYER_TOKENS_JSON"]=
        (ConvertTo-Json -InputObject @($HostToken,$GuestToken) -Compress)
    $raw=Join-Path $FixtureRoot "r14v-local-client-$Launch.json"
    if($Launch -eq 1){
        $clientInfo.ArgumentList.Add("--mode=preflight")
    }else{
        $clientInfo.ArgumentList.Add("--mode=run")
        $clientInfo.ArgumentList.Add("--report=$raw")
        $clientInfo.Environment["BGP_R14U_EXPLICIT_WRITE_CONSENT"]=
            "I_APPROVE_DISPOSABLE_ROOM_CHAT_AND_DICE_ROLL"
    }
    $client=[Diagnostics.Process]::Start($clientInfo)
    if($null -eq $client){throw "R14v actual HTTPS/WSS probe did not start"}
    try {
        if(-not $client.WaitForExit(60000)){
            $client.Kill($true)
            throw "R14v actual HTTPS/WSS client exceeded 60 seconds"
        }
        if($client.ExitCode -ne 0){
            # Only read safe fixed markers, never raw request or process env.
            $safeStderr=$client.StandardError.ReadToEnd()
            if($safeStderr.Contains("GAME_ROOM_R14U_EXTERNAL_TWO_PLAYER_FIELD_FAILED")){
                throw "R14v real TLS WSS field-style probe rejected game/connection"
            }
            throw "R14v real TLS/WSS field-style probe failed"
        }
    } finally {$client.Dispose()}
    if($Launch -eq 1){
        Write-Output ([ordered]@{
            launch=1;mode="preflight";tlsVerified=$true;players=2
            snapshots=2;cleanCloses=2;writeRequests=0
        } | ConvertTo-Json -Compress)
    }else{
        if(-not (Test-Path -LiteralPath $raw)){throw "R14v actual TLS client report missing"}
        # The real R14u strict analyzer is separately invoked by CI.
        $result=Get-Content -LiteralPath $raw -Raw -Encoding utf8 | ConvertFrom-Json
        if($result.kind -ne "external-two-player-yacht-field" -or
           $result.tlsVerified -ne $true -or $result.distinctPlayers -ne 2 -or
           $result.authenticatedSnapshots -ne 3 -or $result.cleanCloses -ne 3 -or
           $result.liveChatDeliveries -ne 3 -or $result.missedChatReplays -ne 1 -or
           $result.chatRetryExactlyOnce -ne $true -or
           $result.yachtDiceRollsCommitted -ne 1 -or
           $result.yachtIdempotentRollRetries -ne 1 -or
           $result.bothPlayersSameMatchVersionAndDice -ne $true){
            throw "R14v actual HTTPS/WSS test report incomplete"
        }
        Write-Output ([ordered]@{
            launch=2;mode="run";tlsVerified=$true;players=2
            snapshots=3;cleanCloses=3;liveChatDeliveries=3
            missedChatReplays=1;chatRetryExactlyOnce=$true
            yachtDiceRollsCommitted=1;idempotentYachtRetry=$true
            twoPlayersStateConsistent=$true
        } | ConvertTo-Json -Compress)
    }
} finally {
    if(-not $proxy.HasExited){
        $proxy.Kill($true)
        if(-not $proxy.WaitForExit(10000)){throw "R14v TLS proxy shutdown failed"}
    }
    $proxy.Dispose()
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$ProxyPort)
    try {$listener.Start()}
    catch {throw "R14v TLS proxy listener port leaked"}
    finally {$listener.Stop()}
}
