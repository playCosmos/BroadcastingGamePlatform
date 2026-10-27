# R13p — Canonical telephone drawing shape tools

**Stack:** R13p Draft on verified R13o #71 (`feature/common-game-room-r13o-private-draft-recovery`). Do not merge or release.

## Scope and design
- Add four accessible exclusive drawing modes: freehand pen (default), straight line, outlined rectangle, outlined ellipse. Provide clear pressed-state and short localized helper text. Existing color palette, brush width, COOP eraser, undo/redo, touch, and tab-local unfinished-draft recovery remain available.
- A pointer gesture begins at a normalized in-canvas point. While dragging, render a preview with the current pointer position but do not append more than one new stroke. Commit **one** canonical stroke on pointerup; pointercancel and lostpointercapture revert to the pre-gesture canvas and leave undo history unchanged. Use a single source of truth for drag preview and final geometry.
- Shape output uses the existing `{points:[{x,y}],color:"#RRGGBB",width:integer}` payload, with no new kind/type persisted. Line: 2 endpoints; rectangle: closed 5-vertex polyline; ellipse: closed 65-point polyline (≤96 server point limit). A zero-distance gesture is a dot. Points are clamped to 0..1; shape endpoints never leave the drawing canvas. A committed shape consumes **one** of the existing 100-stroke allowance and a single undo entry. Default freehand and COOP inherited strokes behave unchanged.
- Selecting a shape exits eraser; selecting eraser returns to freehand mode. Palette color changes clear eraser but preserve the current pen/shape selection. Disable shape switching while any pointer gesture or submission is in progress. Use `aria-pressed` per mode, a labeled group and 44px+ touch targets.
- Only currently authorized unsubmitted DRAWING authors can use tools. Spectators, waiting/finished players, text phases and gallery are read-only. Shape additions never change the authoritative phase, reveal cursor, room membership, or previous COOP art. Existing R13o draft storage serializes each shape as a regular stroke and restores it pixel-identically.
- Keep implementation local to existing `telephone.js` and room markup: no server endpoint, database migration, new package or extra front-end file.

## Gates
- Static client contracts for default pen, shape selection, bounded 5/65-point geometry, controlled pointer lifecycle, eraser precedence and tab-local draft compatibility.
- Real Chrome+Edge NORMAL and COOP browser E2E in actual four-member rooms: touch/mouse line, rect and ellipse pre-submit previews with exactly one stroke each; canceled shape leaves canvas unchanged; one undo/redo per gesture; persisted color/width and ≤96-point canonical server input; drawing reload restores shape with no server mutation; inherited COOP base cannot be edited; spectator and submitted-phase controls remain disabled.
- Keep existing R1–R13o probes and Windows x64 packaging green at the exact PR head. Draft remains stacked and unmerged.
