# R13h — Completed telephone album PNG export

**Stack:** R13h Draft over R13g #63 (`feature/common-game-room-r13g-drawing-tools`). No merge/release, schema migration, additional runtime package, or server route.

## Goal

Save a complete NORMAL or COOP telephone story as **one PNG** after REVEAL, without advancing the authoritative host slideshow, leaking an incomplete/private drawing, or altering room state. This creates a useful take-away for streamers, guests and spectators.

- A **현재 앨범 이미지 저장** control appears only in the finished reveal panel, available to every already-authorized viewer (including spectators). Before reveal the control is hidden by its parent and client action refuses to export.
- The saved poster contains **every stage** of the currently presented album in sequence, with the stage number, author attribution, TEXT stage lines wrapped without clipping, and DRAWING frames faithfully rasterized from validated stroke snapshots.
- The full story is composed **client-side** from the already permitted `state.albums`; no external fonts, images, CDN calls, uploads or additional endpoints. Filename contains only `gamecenter-telephone-album-N.png` with a positional number, never user-supplied text.
- Export snapshots the currently presented album; it does not call the host `/present` or `/playback` endpoints or affect synced album/step/revision, timer, multiplayer WebSocket and presentation.
- Composite canvas size is capped for the server maximum 12-stage story. Use `toBlob('image/png')` instead of a full data URL, disable duplicate exports while encoding, display a failure status for unsupported/failed encoding and revoke temporary object URLs after download.
- Respect server-side reveal ACLs. Do not add a client endpoint for unrevealed art or store persistent album data in local storage.

## Verification

- Static client probe: export button and API-free guarded path, rasterizes normalized drawings only after reveal.
- Actual Chrome/Edge NORMAL+COOP three-author/spectator scenarios: pre-reveal hidden and action rejected, spectator can export the **entire** authorized album as a valid PNG with several frames, filename safe, no network request during export, and host presentation revision remains unchanged. Verify downloads follow whichever album the host currently presents.
- All R1–R13g probes, JavaScript lint/syntax, real-browser E2E, Windows x64 package verification/upload must pass on the exact PR head.
