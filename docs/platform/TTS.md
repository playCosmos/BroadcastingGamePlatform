# Platform TTS Foundation — multi-voice, standalone first

Status: **FOUNDATION / manual preview only**. The existing Board, Drawing Guess,
Viewer Draw and planned Yacht modules are **not wired** to TTS.

## Motivation

Keep speech synthesis, voice catalogs, queues and lifetime outside individual
games and provider SDKs. Multiple voice types, downloadable voice packs and
optional remote engines must be added through `TtsService.TtsEngine` adapters
without altering Board or Drawing Guess logic.

## Implemented in foundation

- `TtsService`: bounded FIFO synthesis queue (16 waiting), one worker,
  24 recent in-memory job records, 5 MiB WAV cap per job, input length
  1–200 Unicode code points, speed -10…10, volume 0…100.
- `TtsEngine`: `id()`, `voices()`, `synthesize(...)` abstract contract.
  Voice IDs are namespaced `engine-id/voice-name`; catalogs can merge voices
  from multiple engines. No single default voice is hardcoded.
- `WindowsSapiEngine`: opt-in native Windows `System.Speech` voice discovery
  and WAV generation through bounded non-interactive PowerShell processes.
  Text and voice names are passed as base64 UTF-8 within a UTF-16 command.
  No shell interpolation or third-party TTS runtime; temporary files are
  removed and synthesis has a 30-second timeout.
- Admin-only `/api/v1/tts` API with same-Origin mutation policy and
  existing admin session validation.
- Dedicated `/admin/tts/` page to inspect available voices, select a voice,
  rate and volume, synthesize sample sentences, download WAV into browser
  memory and replay with an ordinary HTML audio control.
- Voice discovery may legitimately return zero voices; the UI displays that
  state instead of inventing an installed language/voice.
- No audio is included in public HTTP/WS contracts. No chat, donation,
  Board or Drawing Guess event is read or spoken by this initial module.

## Admin API

All routes require a valid admin session.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/tts/voices` | Installed voice catalog with engine IDs |
| GET | `/api/v1/tts/status` | Queued / active synthesis and engine status |
| POST | `/api/v1/tts/speak` | Submit a manually entered text/voice/rate/volume |
| GET | `/api/v1/tts/jobs/{uuid}` | Observe QUEUED/SYNTHESIZING/READY/FAILED/CANCELLED |
| GET | `/api/v1/tts/jobs/{uuid}/audio` | Retrieve generated WAV after READY |
| DELETE | `/api/v1/tts/queue` | Discard waiting jobs; no interruption of active job |

Example JSON:

```json
{"text":"안녕하세요.","voiceId":"windows-sapi/Microsoft Heami Desktop","rate":0,"volume":80}
```

Always select the `voiceId` from the actual `voices` response. This example
is **not** a guarantee that the named voice exists on the host computer.
Jobs and audio are volatile and expire/evict; restarting the server does not
replay previous speech. Speech content is not persisted or logged.

## Extension contracts and phased follow-up

1. Foundation validation: compile, run fake multi-engine / queue probes, then
   test voice discovery and WAV preview on a Windows machine with an installed
   compatible speech voice.
2. Multi-voice engine adapters: add an installed voice pack provider and/or
   additional native/cloud adapters; support voice metadata (gender, style,
   expressive characteristics, license) and capabilities without switching
   existing IDs; show per-voice preview and explicit download/install consent.
3. Persistent administrator defaults: voice, speed, volume and policy settings.
   Do not store generated audio in DB. Use bounded file caching if needed.
4. Exclusive OBS speech output per broadcast channel and audio focus,
   only after a separate output/security specification is approved.
5. Game and SOOP event integration stays deferred until the user requests it.

## Security and constraints

- Never allow public users, room codes or chat messages to invoke synthesis.
- Keep synthesis off synchronous `PlatformEventBus` listeners.
- Set per-request size limits, process timeout, bounded queue and WAV size.
- Never include speech text in logs, player payloads or public errors.
- Native voice availability varies by Windows user/installation; SAPI may not
  expose modern OneCore voices. Additional engines are future adapters, not
  a hidden automatic installation.
- Engine failure must never affect game state or room lifecycle.
