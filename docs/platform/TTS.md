# Platform TTS Foundation — multi-voice, standalone first

Status: **TTS foundation complete for v0.1.1 / administrator manual preview only**. The existing Board, Drawing Guess,
Viewer Draw and planned Yacht modules are **not wired** to TTS.

## Motivation

Keep speech synthesis, voice catalogs, queues and lifetime outside individual
games and provider SDKs. Multiple voice types, downloadable voice packs and
optional remote engines must be added through `TtsService.TtsEngine` adapters
without altering Board or Drawing Guess logic.

## Implemented in foundation

- `TtsService`: bounded FIFO synthesis queue (16 waiting), one worker,
  24 recent in-memory job records, 5 MiB WAV cap per job and an aggregate
  **16 MiB preview-audio retention cap**. Older audio is evicted first while
  its retained job metadata changes to `EXPIRED`. Input length is
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
- `PiperEngine`: optional neural-voice adapter, using an independently
  installed `piper` executable on PATH and trusted model pairs from
  `<application-root>/tts/voices/<model>.onnx` and matching
  `<model>.onnx.json`. The platform never downloads these files. Speaker maps
  in multi-speaker models create distinct selectable voices. The adapter
  supports rate through Piper `--length_scale` and volume through checked
  16-bit PCM WAV scaling. The output remains bounded by the same WAV limit.
  The voice pack directory is not exposed through the public web root.
- `TtsEngineRegistry`: built-in engine registration plus trusted on-classpath
  Java SPI engine discovery. Avoid loading untrusted plugins from arbitrary
  folders; duplicates and broken optional providers are ignored.
- Rich voice catalog metadata: language, engine, gender (when reported), style
  labels and source. These are metadata, not guarantees about audio quality.
- `TtsPreferencesStore`: administrator defaults (voice ID, speed and volume)
  saved atomically to `tts-settings.json` in the application root.
- `TtsVoiceProfileStore`: up to 24 administrator-named voice/rate/volume
  presets, stored separately in `tts-profiles.json` with atomic replacement.
  Profiles can be added, overwritten by name, applied or deleted without
  changing global defaults. Missing voice IDs remain intact for later reuse;
  corrupt optional profile files are preserved and loaded as an empty list.
  A missing voice stays selected in the saved profile for later restoration.
  Invalid or unreadable optional settings recover to safe defaults without
  blocking the game server; the original file is preserved for inspection.
- Admin-only `/api/v1/tts` API with existing admin session validation.
  POST/PUT/DELETE speech mutations reject both cross-origin and origin-less
  requests and require an explicit trusted `Origin` header.
- Dedicated `/admin/tts/` page to inspect available voices, select a voice,
  rate and volume, synthesize sample sentences, download WAV into browser
  memory and replay with an ordinary HTML audio control.
- Voice discovery may legitimately return zero voices; the UI displays that
  state instead of inventing an installed language/voice.
- No audio is included in public HTTP/WS contracts. No chat, donation,
  Board or Drawing Guess event is read or spoken by this initial module.

## Voice-engine extension and saved preferences

The foundation now includes **three optional local backends** and a Java SPI
extension point. Windows SAPI uses installed Windows desktop voices; eSpeak NG
is detected only when its `espeak-ng` executable is already available on
`PATH`. Piper is discovered only when the independently installed `piper`
command is available and matching ONNX/JSON models are in `tts/voices`.
No external executable or voice pack is installed by the platform.
`TtsEngineRegistry.installed()` registers the local built-ins, then accepts trusted
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
| GET | `/api/v1/tts/profiles` | List administrator-named voice profiles |
| PUT | `/api/v1/tts/profiles` | Create/replace a profile by name, body: `{"name":"Korean","voiceId":"engine/voice","rate":0,"volume":80}` |
| DELETE | `/api/v1/tts/profiles` | Delete by name, JSON body: `{"name":"Korean"}` |
| GET | `/api/v1/tts/status` | Queued / active synthesis, engine status, retained audio bytes and cache limit |
| POST | `/api/v1/tts/speak` | Submit a manually entered text/voice/rate/volume |
| GET | `/api/v1/tts/jobs/{uuid}` | Observe QUEUED/SYNTHESIZING/READY/FAILED/CANCELLED/EXPIRED |
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

Each `READY` WAV is held in memory for administrator preview only. Once the
aggregate 16 MiB cache budget would be exceeded, the oldest retained WAV is
discarded and its job becomes `EXPIRED` (metadata stays available until the
normal 24-record retention policy prunes it). `EXPIRED` audio is unavailable
and administrators must synthesize a new preview if needed. A status-to-audio
request may race with eviction; `GET .../audio` then returns HTTP 409.
All preview WAVs additionally expire **15 minutes after synthesis completes**,
independent of the cache's byte utilization or the administrator's page activity.
The service reclaims expired WAVs during ordinary API activity and in its idle
worker loop. Both time-based expiry and byte-budget eviction preserve an
`EXPIRED` job record until normal metadata pruning. The 16 MiB limit applies
to **retained previews**, not transient engine output buffers, HTTP response
copies, process memory, or the total server heap.

## Current administrator workflow

1. Open `http://127.0.0.1:17832/admin/tts/` after administrator login.
2. Filter the installed voice catalog by language or engine. Windows SAPI
   voices appear where installed; eSpeak NG voices appear **only if that
   third-party executable is already installed** and available on PATH.
   Optional neural Piper voices appear only when the separate `piper` command
   works and model/config pairs have been manually placed in `tts/voices`.
   Run **Refresh** after adding files.
3. Select a voice, inspect the supplied gender/style/source metadata and
   synthesize a sample sentence to hear its output.
4. Save the chosen voice/rate/volume as administrator defaults. Reload to
   verify persistence. If a previously selected voice is uninstalled, the
   administrator should be notified rather than silently deleting its ID.
   Optionally save the current selection under a named voice profile, then
   apply that profile later without changing the global defaults. Profiles
   whose original voice is unavailable show an explicit warning and do not
   silently substitute a different voice. The server permits up to 24 profiles
   and validates names (1–40 Unicode code points, no surrounding whitespace
   or control characters).
5. Use Refresh after installing a new local voice. Voice pack
   installation/update/removal is deliberately **not** implemented here.

## End-to-end validation and final acceptance

- The regular Windows package CI compiles the server, runs TTS queue/WAV/
  cache/timeout and authenticated HTTP/CSRF probes, verifies the shipped
  `/admin/tts/` assets, and checks the packaged Windows launcher.
- `.github/workflows/platform-tts-engine-smoke.yml` runs on a temporary Linux
  runner and **requires real eSpeak NG** speech synthesis through `TtsService`.
  It also uses a separately installed Piper engine and a SHA-256-verified,
  MIT-licensed example ONNX voice model to validate actual neural synthesis
  and RIFF/WAV output. The model and engine are removed after the test; they
  are not shipped with the application or downloaded by the server.
- Windows packaging CI checks native SAPI synthesis **when enabled Windows
  desktop voices are present**. An empty catalog is reported as
  `TTS_ENGINE_SMOKE_SKIPPED`; PowerShell, JSON parser or native backend
  failures fail the smoke test rather than silently passing.
  Such a skip is **not** proof of Windows voice compatibility.
- Final Windows SAPI acceptance requires a machine with at least one actual
  installed desktop voice: open `/admin/tts/`, verify authenticated access,
  select a voice, synthesize Korean text if available, and listen to the
  result. Test failure must not prevent game or room operations.
- Validate optional Piper models from trusted sources, confirm per-model
  voice licenses, and check that source speech and generated WAVs are not
  persisted by the server. An untested voice model is not certified by a
  passing engine fixture smoke test.

Three native backend smoke checks (Windows SAPI, eSpeak NG and Piper) and
Windows package regression checks passed before the v0.1.1 release. Listening
and voice-quality acceptance on the operator's own machine remain recommended
post-release checks. No game/provider/OBS event-to-speech integrations are
included in the foundation release.

## TTS consolidated release policy

The standalone TTS foundation is consolidated in **v0.1.1**.
The three intermediate TTS test releases and their matching Git tags
(`v0.1.1-alpha.5`, `v0.1.1-alpha.6`, `v0.1.1-alpha.7`) were intentionally
removed. Board-specific releases/tags `alpha.1` through `alpha.4` remain
unchanged. Removal of release artifacts does not remove TTS source commits.

**Do not recreate the deleted TTS intermediate releases or tags.**
The completed standalone foundation is delivered as one v0.1.1 package.
Game/provider/OBS integrations remain deferred until separately authorized.
Voice adapters and new voice-pack management are future independent work.
Named voice profiles are implemented in the subsequent profile feature branch;
they are not part of the frozen v0.1.1 foundation package.

## Next milestones (not implemented)

1. Safe optional local voice pack management after publishing a trusted pack
   manifest, licenses, version checks, checksums and rollback behavior.
2. Additional trusted local/cloud adapters through `TtsService.TtsEngine`,
   and real-device Piper compatibility/quality verification.
3. Further audio-generation efficiency work and runtime memory profiling.
   The bounded in-memory preview cache now enforces both a 16 MiB budget and a
   15-minute age limit. Persistent/cross-session caching is not planned for
   this stage.
4. Optional OBS speech output and game/provider integrations **only after**
   explicit approval of their separate execution contracts.

## Security and constraints

- Never allow public users, room codes or chat messages to invoke synthesis.
- Keep synthesis off synchronous `PlatformEventBus` listeners.
- Set per-request size limits, process timeout, bounded queue and WAV size.
- Never include speech text in logs, player payloads or public errors.
- Voice-profile read/write/delete routes require administrator authentication;
  mutations also require a trusted Origin. Each profile request is limited
  to 4 KiB and persisted profile documents to 16 KiB. The profile store
  contains metadata only and never synthesizes or persists speech samples.
- Native voice availability varies by Windows user/installation; SAPI may not
  expose modern OneCore voices. eSpeak NG and Piper must be separately installed
  and are never bundled or downloaded by the platform. Piper ONNX model
  execution and voice licensing remain the operator's responsibility.
- Engine failure must never affect game state or room lifecycle.
