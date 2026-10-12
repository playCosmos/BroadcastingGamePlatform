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
- `EspeakNgEngine`: optional eSpeak NG adapter; automatically detects the
  executable on the server PATH and enumerates installed local voice packs.
  Works on Windows when eSpeak NG is installed separately; without the
  executable it reports zero voices. It never downloads an engine or model.
- `TtsEngineRegistry`: built-in engine registration plus trusted on-classpath
  Java SPI engine discovery. Avoid loading untrusted plugins from arbitrary
  folders; duplicates and broken optional providers are ignored.
- Rich voice catalog metadata: language, engine, gender (when reported), style
  labels and source. These are metadata, not guarantees about audio quality.
- `TtsPreferencesStore`: administrator defaults (voice ID, speed and volume)
  saved atomically to `tts-settings.json` in the application root.
  A missing voice stays selected in the saved profile for later restoration.
  Invalid or unreadable optional settings recover to safe defaults without
  blocking the game server; the original file is preserved for inspection.
- Admin-only `/api/v1/tts` API with same-Origin mutation policy and
  existing admin session validation.
- Dedicated `/admin/tts/` page to inspect available voices, select a voice,
  rate and volume, synthesize sample sentences, download WAV into browser
  memory and replay with an ordinary HTML audio control.
- Voice discovery may legitimately return zero voices; the UI displays that
  state instead of inventing an installed language/voice.
- No audio is included in public HTTP/WS contracts. No chat, donation,
  Board or Drawing Guess event is read or spoken by this initial module.

## Voice-engine extension and saved preferences

The foundation now includes **two optional local backends** and a Java SPI
extension point. Windows SAPI uses installed Windows desktop voices; eSpeak NG
is detected only when its `espeak-ng` executable is already available on
`PATH`. No external executable or voice pack is installed by the platform.
`TtsEngineRegistry.installed()` registers both built-ins, then accepts trusted
classpath `ServiceLoader<TtsService.TtsEngine>` adapters with unique engine IDs.

The voice catalog provides namespaced voice IDs, localized language tags,
known gender, optional styles, and source metadata. Unknown attributes are
reported as unknown rather than inferred. Not every Windows voice is exposed
by the legacy SAPI API; do not promise specific installed voices.

The administrator voice laboratory supports language and engine filters,
per-voice metadata and an explicit **Save as defaults** action. Global defaults
(`voiceId`, `rate`, `volume`) are written atomically to
`tts-settings.json` in the application root. Only these three fields are
persisted: sample text, synthesized speech, tokens and jobs are **not**
written to settings. An empty `voiceId` uses the first matching Korean voice
shown by the UI. A saved voice removed from the host is reported as missing;
the stored selection is not silently rewritten. Malformed settings cannot
prevent the entire platform from starting; the original file is preserved
until an administrator explicitly saves corrected settings.

Additional installed engines can implement `TtsEngine` and be included in
the trusted application classpath with
`META-INF/services/io.github.playcosmos.broadcastinggameplatform.platform.tts.TtsService$TtsEngine`.
The SPI mechanism **does not** automatically load external jars, download
models, execute arbitrary paths, or grant OBS/game access.

## Admin API

All routes require a valid admin session.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/tts/voices[?refresh=1]` | Installed voice catalog, metadata, manual refresh |
| GET/PUT | `/api/v1/tts/settings` | Persisted default voice, rate and volume |
| GET | `/api/v1/tts/settings` | Retrieve saved default voice, rate and volume |
| PUT | `/api/v1/tts/settings` | Persist new defaults (admin-only, same-origin) |
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

## Current administrator workflow

1. Open `http://127.0.0.1:17832/admin/tts/` after administrator login.
2. Filter the installed voice catalog by language or engine. Windows SAPI
   voices appear where installed; eSpeak NG voices appear **only if that
   third-party executable is already installed** and available on PATH.
3. Select a voice, inspect the supplied gender/style/source metadata and
   synthesize a sample sentence to hear its output.
4. Save the chosen voice/rate/volume as administrator defaults. Reload to
   verify persistence. If a previously selected voice is uninstalled, the
   administrator should be notified rather than silently deleting its ID.
5. Use Refresh after installing a new local voice. Voice pack
   installation/update/removal is deliberately **not** implemented here.

## Next milestones (not implemented)

1. Safe optional local voice pack management after publishing a trusted pack
   manifest, licenses, version checks, checksums and rollback behavior.
2. Additional native/neural adapters using `TtsService.TtsEngine`.
3. Audio generation efficiency improvements and bounded caching.
4. Optional OBS speech output and game/provider integrations **only after**
   explicit approval of their separate execution contracts.

## Security and constraints

- Never allow public users, room codes or chat messages to invoke synthesis.
- Keep synthesis off synchronous `PlatformEventBus` listeners.
- Set per-request size limits, process timeout, bounded queue and WAV size.
- Never include speech text in logs, player payloads or public errors.
- Native voice availability varies by Windows user/installation; SAPI may not
  expose modern OneCore voices. eSpeak NG must be separately installed and
  is never bundled or downloaded by the platform.
- Engine failure must never affect game state or room lifecycle.
