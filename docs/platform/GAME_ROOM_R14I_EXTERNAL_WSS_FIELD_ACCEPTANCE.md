# R14i — External HTTPS/WSS field acceptance

Parent: R14h Draft PR #90, validated at `16c76d72bd4d423bc366365daf2d96d86d1fb1be`. R14i remains a stacked Draft with no merge or release.

## Purpose

R14h already validates two graceful exits of a real packaged Windows EXE and a 24-round Drawing/Yacht loopback transport soak. R14i adds a **read-only external deployment probe** for real HTTPS certificate trust, WSS reverse proxy routing, authenticated room snapshots, monotonic event cursor and repeated clean reconnect.

The new `server/smoke-external-game-room-wss.mjs` requires Node 22+, a **temporary spectator bearer** in environment variable `BGP_WSS_PROBE_TOKEN`, public HTTPS origin and a known room UUID. It performs only HTTP GET `/api/client/config`, `/api/v1/room-membership/me` and WebSocket `room.subscribe`; it does not create, join, kick, close or modify any room. The bearer is transmitted in the WSS frame, never in a URL, report or CLI argument. Redirects are refused. TLS and hostname verification remain **enabled**.

## Run on Windows (PowerShell)

Choose a temporary spectator token in a disposable room you control. For the normal public site, the advertised WSS origin must match your HTTPS host. If WSS is on a separate host/port/path, provide `--wss=wss://socket.example.com/path/` only after verifying the endpoint is yours and exactly matches `/api/client/config`.

```powershell
$credential = Read-Host 'Spectator token' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential)
try {
    $env:BGP_WSS_PROBE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    node .\server\smoke-external-game-room-wss.mjs `
        --base=https://games.example.com `
        --room-id=00000000-0000-4000-8000-000000000001 `
        --rounds=100 --interval-ms=2000 `
        --report="$env:TEMP\r14i-wss-metrics.jsonl"
} finally {
    Remove-Item Env:\BGP_WSS_PROBE_TOKEN -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
```

Replace example hostname, UUID and token before running. Private CAs can be added via `NODE_EXTRA_CA_CERTS`. **Never** use `NODE_TLS_REJECT_UNAUTHORIZED=0` or expose the bearer in a command line. The JSONL report contains a start record, latency/memory samples and a summary. Do not commit private deployment telemetry.

Supported arguments: `--base`, optional explicitly approved `--wss`, `--room-id`, `--rounds` (1–100000, default 3), `--interval-ms` (250–3600000, default 1000), `--timeout-ms` (3000–120000, default 15000), optional `--report` (must not already exist). A passive observer does not heartbeat to keep its room alive.

## Automated acceptance

The Chrome/Edge HTTPS/WSS fixture uses a real ephemeral `keytool` TLS certificate and proxy. It exports a disposable PEM trust anchor, launches the **same field CLI** using `NODE_EXTRA_CA_CERTS`, checks three authenticated WSS snapshots and the JSONL latency report, and verifies neither outputs nor report contain the member bearer. Normal TLS validation is never disabled. Existing real-browser abrupt WSS outage recovery tests and R14h 24-round Java/Windows EXE checks remain mandatory.

## Remaining deployment gates

CI remains a local TLS proxy, not a public certificate chain, WAN route or operator's reverse-proxy topology. The CLI tests **clean re-subscriptions**, not forced carrier outages or a 24-hour soak. Measured Node heap/RSS are **probe-process telemetry**, not server memory; do not claim server memory-leak absence. Real Windows Explorer tray menu clicks, host process telemetry, actual external WAN/TLS, and signed distribution remain manual/field acceptance.