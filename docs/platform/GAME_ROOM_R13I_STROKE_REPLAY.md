# R13i — completed telephone drawing stroke replay

**Stack:** Draft R13i on R13h #64 (`feature/common-game-room-r13h-album-export`). Preserve the host-authoritative R13d–f reveal cursor, R13g drawing ownership, and R13h static PNG export.

## Interaction and ownership
- When the currently shared REVEAL stage is a DRAWING, every authorized member (PLAYER or SPECTATOR) sees **그림 그리는 과정 보기**. Text stages never show this control. No control is displayed before reveal.
- Clicking it plays a **local, opt-in**, point-by-point reconstruction of the currently shown drawing on the existing reveal canvas. Playback can be stopped, showing the exact complete original drawing; completion restores the exact final canonical image and allows replay again.
- Repeated room HTTP snapshots or WebSocket updates for the **same** album/step do not interrupt replay. As soon as the authoritative album/step changes (manually or through autoplay), the old local animation cancels and the newly authorized image renders immediately. Leaving the game or resetting the phase cancels it too.
- The original stroke order, widths, colors, normalized coordinates and 1-point taps are preserved. For COOP this replays the cumulative, immutable committed strokes only; client never changes or submits artwork.
- Use native `requestAnimationFrame` with a capped overall duration, normalized drawing data already returned for REVEAL, and a cancellation fence to prevent drawing into obsolete DOM after a slide switch. Respect the host cursor and do not add local UI for selecting another slide.
- No additional server routes, database migrations, object storage, external dependencies, privileged browser APIs or serialization changes. R13h PNG export continues to render complete static albums, independent of replay.

## Acceptance tests
- Extend static Drawing-room contract for guarded reveal-only read-only replay, cleanup and animation controls.
- Actual Chrome/Edge NORMAL and COOP full-room E2E must verify pre-reveal denial, TEXT stages hide controls, DRAWING stage replay starts and visibly changes a canvas, stop restores the exact complete image, replay completion restores the exact canonical image, periodic snapshot refresh does not disrupt replay, and host server revision/slide remains unchanged.
- Verify that host slide navigation cancels a spectator's local replay and restores a correctly authorized new frame; validate all previous R1–R13h regressions, Windows x64 package and exact-head CI.
- Keep PR Draft, do not merge or release.
