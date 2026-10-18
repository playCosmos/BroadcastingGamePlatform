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
- `TtsVoicePackStore`: local Piper ONNX/JSON inventory and opt-in managed
  allowlist stored in `tts/voice-packs.json`. An operator registers an
  existing model by filename stem with externally verified model SHA-256,
  pack version, license identifier and explicit license acknowledgement.
  The corresponding JSON digest is recorded automatically. Management
  actions cannot upload, download or delete the model files. Disabled,
  unregistered, tampered or missing managed packs do not synthesize speech.
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
| GET | `/api/v1/tts/packs` | Local Piper inventory and LEGACY/MANAGED/INVALID registry mode |
| PUT | `/api/v1/tts/packs` | Register/replace a local model using `model`, `version`, `license`, `sha256`, `licenseAcknowledged:true` |
| POST | `/api/v1/tts/packs/verify` | Recompute local model/config SHA-256 for the chosen `model` |
| POST | `/api/v1/tts/packs/status` | Enable/disable a registered model using `model` and boolean `enabled` |
| DELETE | `/api/v1/tts/packs` | Unregister a model by `model`, leaving local ONNX/JSON files intact |
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
5. Use Refresh after manually placing a Piper model. In the **local voice
   pack management** section, select a detected model, confirm its real license
   and external SHA-256, supply a version and license identifier, acknowledge
   the terms and register it. Recheck its digest, disable/enable, or unregister
   as needed; these controls never remove the actual ONNX/JSON files.

## Local voice pack management: migration and trust boundary

- The application never downloads a model, installs Piper, accepts uploaded
  model bytes, executes binaries from `tts/voices`, or removes model files.
  The operator places `<model>.onnx` and `<model>.onnx.json` as a pair in
  `<application-root>/tts/voices`, and must install Piper separately on PATH.
- Before the first successful registry save (no manifest), **LEGACY mode**
  retains the pre-existing manual file discovery behavior. The first
  successful model registration creates `tts/voice-packs.json` and enters
  **MANAGED mode**: only enabled, registered models whose *ONNX and JSON*
  checksums still match will be listed or synthesized. Existing unregistered
  models will disappear from the voice selector until registered. Back up
  your manifest and register all required models before relying on them.
  The manifest remains even after the last registration is removed so
  unregistered models never unexpectedly become active again.
- If the saved manifest is malformed, too large, duplicated, or unsafe,
  **INVALID mode** fails closed, disables all Piper packs and preserves
  the file for manual repair. Never delete a damaged manifest as an
  automatic recovery measure: deleting it restores LEGACY discovery.
- An expected SHA-256 for the ONNX file is required from a separately
  trusted publisher/source; calculating a digest locally verifies file
  identity but does **not** by itself prove its provenance. The companion
  JSON checksum is recorded at registration. License identifier and version
  are *operator declarations*, not independently verified certifications.
  Model files may be up to 1 GiB, JSON configs to 256 KiB, and the registry
  supports up to 64 entries. Hash checks during discovery and synthesis
  intentionally add I/O overhead in managed mode.
- CLI examples: `Get-FileHash -Algorithm SHA256 .\\tts\\voices\\sample.onnx`
  (PowerShell) and `sha256sum tts/voices/sample.onnx` (Linux). Compare
  the digest against the trusted publisher's expected SHA-256.
- Removing a registration does not delete files, touch saved global voice
  preferences, or erase named profiles. Previously selected unavailable
  voices remain visible as missing in profile/default settings.

## Runtime reuse, memory bounds and diagnostics

- Within the existing in-memory 15-minute preview retention and aggregate
  16 MiB limit, an identical voice ID, text, rate and volume may reuse a
  previously completed WAV instead of launching another native synthesis.
  Cached audio is copied into a **separate job**, with independent job ID,
  expiry and retention accounting. No disk-backed or cross-restart cache is
  created, and no speech text is added to logs or public status fields.
- Reuse is an explicit `TtsEngine.reusablePreview()` opt-in. Windows SAPI and
  eSpeak NG opt in for repeated administrator previews; other and third-party
  engines continue synthesizing for every request unless they deliberately
  opt in. **Piper explicitly remains uncached** to preserve ONNX/config
  integrity verification on every synthesis. The first synthesis for a
  unique request still executes the selected native engine.
- An explicit `/api/v1/tts/voices?refresh=1` or a voice-pack registry mutation
  invalidates reuse across catalog generations. Changing speech rate, volume,
  voice or text also prevents reuse. Expired, evicted, failed and canceled jobs
  are never reuse candidates.
- The administrator status response now includes cumulative
  `engineSyntheses`, `previewReuses`, `synthesisFailures` and
  `lastSynthesisMillis`. These counters reset on process restart, measure
  only the in-process lifetime, and do not include speech text or WAV data.
  Last synthesis latency measures the engine's call, not queue wait time or
  client playback. They are diagnostics, not hardware-independent benchmarks.
- Recoverable native provider linkage failures and assertion errors mark
  the affected job FAILED without killing the worker; following jobs
  continue. Irrecoverable process-level failures are not masked.

## Real Piper inference profiling (Linux CI)

The optional, ephemeral Linux native-engine workflow now benchmarks a pinned,
SHA-256-verified Piper ONNX example voice (`en_US-lessac-low`,
`piper-tts==1.8.0`). It invokes the **real** Piper process through the
platform's Java `TtsService` (not mock audio), five times in each mode:

- `LEGACY`: manually discovered trusted model/config pairs.
- `MANAGED`: the same pair registered with the externally supplied ONNX
  SHA-256, with model/config integrity checks still enforced per synthesis.
- A separate preloaded-model Python probe measures warm model inference
  without repeating the process startup or ONNX load. This is **diagnostic
  only**, not a production Python dependency.

The first benchmark run, [CI #20](https://github.com/playCosmos/BroadcastingGamePlatform/actions/runs/39130958017),
reported these **observed measurements**, not universal performance claims:

| Metric | LEGACY (5 requests) | MANAGED (5 requests) |
|---|---:|---:|
| Mean end-to-end request latency | 1,805 ms | 1,802 ms |
| Median latency | 1,786 ms | 1,798 ms |
| Maximum observed latency | 1,940 ms | 1,825 ms |
| Maximum sampled Piper subprocess RSS | 191,692 KiB | 190,936 KiB |
| Maximum sampled JVM RSS | 94,508 KiB | 130,752 KiB |
| Maximum observed used JVM heap | 24,866 KiB | 61,780 KiB |

Initial Piper catalog discovery took 177 ms; a repeat cached discovery
was below the millisecond reporting resolution. The two modes ran
sequentially on a shared CI host, so the higher JVM RSS in the second phase
cannot be attributed to managed mode. The two latency means differ by only
3 ms and show **no demonstrated managed-hash throughput bottleneck** in this
five-sample fixture. Approximate process RSS peaks come from periodic Linux
`/proc` sampling and may underestimate very short peaks. JVM heap samples
are not GC-normalized and are not a heap-leak measurement.

A second successful run, [CI #23](https://github.com/playCosmos/BroadcastingGamePlatform/actions/runs/39131231454),
added a same-host `PiperVoice.load()` warm inference comparison:

| Metric (second CI run) | Legacy subprocess | Managed subprocess | Preloaded Python |
|---|---:|---:|---:|
| Mean synthesis time | 1,551 ms | 1,586 ms | 79 ms |
| Median synthesis time | 1,528 ms | 1,574 ms | 78 ms |
| Highest per-request observation | 1,665 ms | 1,692 ms | 86 ms |
| Peak native/Python process RSS | 191,680 KiB | 190,760 KiB | 193,196 KiB |

The preloaded model required **1,276 ms** to load before synthesis.
The subprocess path averaged about 20x the warm inference time on this runner,
but these timings include different host-language and I/O overheads; they
are **not** a proven 20x end-to-end platform speedup. Memory remains
around 190 MiB for a model-loaded Piper process, even when requests are
rare, so a permanently resident process trades lower repeated-request
latency for greater idle RSS. The first CI had 1,805/1,802 ms mean legacy/
managed values: cross-run variability is material and rules out declaring
a meaningful digest-check overhead from these small, sequential samples.

The measured Java end-to-end latency includes native process start, ONNX model
load, phonemization, inference, WAV file I/O and the Java queue. It does not
individually time those stages. The optional preloaded-model comparison
tests whether avoiding per-request process/model startup warrants a
separate, hardened persistent-worker implementation. Do not ship such an
implementation merely because a single runner looks faster: requirements
include model/config integrity before each use, process lifecycle/timeout
and crash recovery, bounded per-voice RSS and worker idle eviction, safe
file ownership and strict isolation from public traffic.

None of these measurements are operator-Windows benchmarks or human
listening/voice-quality acceptance. Do not include temporary native models,
WAVs or Python benchmark dependencies in the shipped platform.

## Optional Piper persistent worker (experimental, opt-in)

The default production Piper adapter remains the tested **one-process-per-
request** CLI. The model-resident subprocess is **off by default** and requires
an operator to explicitly set `BGP_TTS_PIPER_WARM_PYTHON` to an absolute path
for the trusted Python executable in an independently installed `piper-tts`
environment. Example, only if that environment already has Piper installed:

- Linux: `BGP_TTS_PIPER_WARM_PYTHON=/opt/piper-venv/bin/python`
- Windows: `BGP_TTS_PIPER_WARM_PYTHON=C:\\piper-venv\\Scripts\\python.exe`

This is **not** a general Python server and does not listen on TCP/HTTP,
auto-download voice models, install packages, load arbitrary admin scripts or
open a public synthesis endpoint. The platform launches a fixed internal
protocol in an isolated `python -I -u -c` subprocess with the model/config
paths supplied by its already-vetted Piper adapter. If the executable is
unavailable, the legacy CLI stays active. The feature is intended only for
the compatible Python Piper API; the older/native CLI does not expose a
reliable application-owned per-request completion protocol.

The worker is strictly serialized, keeps **at most one loaded ONNX model**,
uses bounded length-prefixed WAV frames on standard output, 30-second shared
startup/input/output timeout, and closes after 60 seconds of inactivity.
Worker failure closes the broken child and attempts the proven standalone
Piper CLI once. A subsequent request may spawn a fresh warm worker. The
application closes any resident worker during `TtsService.close()`, and
a catalog refresh invalidates it. Every warm request also re-hashes the ONNX
and JSON before reuse; an altered model/config forces process replacement.
A changed or disabled managed pack fails validation, terminates the
resident worker, and **must not** fall back to bypassing the registry.
Model and config paths remain restricted to the application-owned voice
directory. Piper is **not** eligible for cross-request WAV reuse in
`TtsService`: speech is regenerated by the currently validated model.

A separate native CI probe verifies 100 sequential real WAVs, forced process
crash/restart, model/config modification and registry revocation, idle
termination/restart, proper JVM shutdown, and fallback when the trusted
worker interpreter cannot start. These are smoke/stability contracts, not
proof of leak-free unlimited operation or a Windows-host benchmark.
The worker's resident process can consume roughly 190 MiB for the included
small fixture; memory consumption varies substantially by model. Keep the
feature disabled until operator-host validation confirms acceptable idle
memory, quality and shutdown behavior. An explicit OS-level RSS quota is
not yet implemented; the one-model limit and idle eviction are the initial
bounds.

## Resident Piper long-soak and resource acceptance gate

The optional `TtsPiperSoakProbe` runs only in the ephemeral Linux real-engine
workflow with a checksum-verified ONNX model. It is deliberately separate
from fast unit probes and executes **1,000 real syntheses** through the
resident model with varied short utterances. Every 100 requests it samples
the child process' `/proc/<pid>/status` RSS and the JVM RSS without saving
speech text, generated audio or native profiling archives. The probe checks
that the *same PID* services all 1,000 requests, that no sample's native RSS
exceeds its 100-request baseline by 64 MiB for this pinned small fixture,
and that all WAV outputs are complete and nonempty. At every 100th sample,
it performs a diagnostic, test-only full JVM GC and measures **retained
live heap**. Post-GC used heap must not grow by more than 32 MiB over the
first checkpoint. These are **coarse regression guards**, not evidence of
zero leaks or portable hard memory caps for arbitrary models. The forced
GC is never performed in normal application synthesis.

It then copies the same trusted test model to a second, differently named
model file in a disposable test root to exercise two physical process
replacements (model A → B → A) and checks that old PIDs have exited.
Subsequent checks force an unexpected child termination and restart,
stop inference **while audio is being synthesized**, and inject a very short
request deadline to test cleanup of a stalled startup. These last two cases
protect against orphaned Python/model processes after platform shutdown and
timeout. The runtime rejects truncated and out-of-range binary WAV frames,
and shutdown never retries a cold Piper CLI if the worker was closed.

The initial successful [Linux 1,000-request soak](https://github.com/playCosmos/BroadcastingGamePlatform/actions/runs/39141337782)
took 145.2 seconds, with native Piper RSS 225,968 KiB at request 100 and
228,884 KiB at request 1,000 (growth 2,916 KiB, around 2.85 MiB).
The JVM RSS increased from 89,720 KiB to 217,176 KiB over the same interval;
this **does not by itself demonstrate a Java object leak** because the VM
may retain committed heap pages even after allocating objects temporarily.
The follow-up retained-heap-after-GC check distinguishes heap residency from
reachable Java objects.

**Acceptance interpretation:** a successful 1,000-request run plus stable
sampled RSS supports a targeted short-run reliability claim, not indefinite
leak-free operation. JIT, file system cache and model size affect timings and
memory; Linux `/proc` is not available natively on Windows. Real operator
Windows memory measurement, actual-model listening, duration-based soak tests
and OS-enforced RSS hard caps are still unverified. Thus resident inference
remains disabled by default and must not be presented as production-approved.

## Administrator Piper runtime operations (opt-in)

The existing authenticated `/admin/tts/` laboratory includes a **Piper resident
worker** panel. It exposes actual state (`DISABLED`, `IDLE`, `READY`,
`SYNTHESIZING`, `CLOSED`), model filename stem, optional resident process
RSS (KiB), total completed/failed/timeout syntheses, model loads, CLI
fallback attempts and most recent/average synthesis time. Counters are
**since the last worker policy reconfiguration**, not historical or
persistent. They never include text, wave bytes, raw PID, a model's
absolute path or the private Python executable path.

- `GET /api/v1/tts/piper/runtime`: admin-only status and settings.
- `PUT /api/v1/tts/piper/runtime`: admin-only, strict trusted Origin,
  JSON `{"enabled":true|false,"idleSeconds":10..600}` (default 60).
  Full policy is atomically stored in `tts/piper-runtime.json` and
  applied to the running worker by terminating the current model, if any.
- `POST /api/v1/tts/piper/runtime/release`: administrator-triggered
  process/model eviction without changing the persisted policy. The
  next speech request initializes the model again.

The warm Python environment is **not** chosen in the admin UI, API or
policy file. The host operator must separately install Piper, set
`BGP_TTS_PIPER_WARM_PYTHON` to an absolute trusted Python executable
and restart the server before resident mode can be enabled. Without that
environment, enabling is rejected. For backward compatibility, setting
the environment alone initially opts in, unless a saved policy explicitly
disables resident mode. An invalid/corrupt settings document is preserved
and fails closed to disabled mode; the operator must repair/remove that
document locally rather than having the API silently overwrite it.
Settings and model registry permissions remain distinct.

Native child RSS uses Linux `/proc/<pid>/status` when available; on
platforms without a supported direct measurement (including Windows),
the UI explicitly displays **measurement unavailable**, not a guessed
value or JVM RSS. The Java worker only tracks counts and durations
locally and does not install system services or polling daemons. The
one-model maximum, timeout, idle reaper and model SHA-256 checks from
the previous milestone remain enforced. This feature is operational
control and monitoring, **not** automatic production approval: real
Windows operator listening, native memory observation and multi-model
stress testing are still outstanding.

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
Voice adapter expansion and any voice-pack distribution service remain future independent work.
The local registration interface is a subsequent feature branch and is not
included in the frozen v0.1.1 foundation release.
Named voice profiles are implemented in the subsequent profile feature branch;
they are not part of the frozen v0.1.1 foundation package.

## Next milestones (not implemented)

1. Local voice pack registration/inventory/disable/unregister now supports
   operator-provided ONNX pairs and a fail-closed digest-checked manifest.
   Distribution, trusted publisher catalogs and automated model installation
   remain deferred; backup/rollback is operator-controlled.
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
- Cached administrator previews stay in the existing memory-only bounded
  retention. No speech text, WAV bytes, job ID or cache key is written to disk.
- Voice-profile read/write/delete routes require administrator authentication;
  mutations also require a trusted Origin. Each profile request is limited
  to 4 KiB and persisted profile documents to 16 KiB. The profile store
  contains metadata only and never synthesizes or persists speech samples.
- Native voice availability varies by Windows user/installation; SAPI may not
  expose modern OneCore voices. eSpeak NG and Piper must be separately installed
  and are never bundled or downloaded by the platform. Piper ONNX model
  execution and voice licensing remain the operator's responsibility.
- Engine failure must never affect game state or room lifecycle.
