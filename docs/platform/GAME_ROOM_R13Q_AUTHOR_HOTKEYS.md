# R13q — Private drawing canvas keyboard authoring shortcuts

**Stack:** R13q Draft on verified R13p #72 (`feature/common-game-room-r13p-shape-tools`). No merge or release.

## Experience and scope
- An authenticated active DRAWING author can operate the local canvas with a keyboard, **only while the actual drawing canvas has focus**: `B` freehand, `L` line, `R` rectangle, `O` ellipse, `E` eraser, `1/2/3` widths 3/6/12px, `Ctrl+Z` undo, and `Ctrl+Shift+Z` or `Ctrl+Y` redo. Shape selection and eraser use the same tools as the existing buttons, not duplicate rendering logic.
- Give the canvas `tabindex="0"`, a visible focus ring, `aria-describedby` and an accessible helper label showing shortcuts. Pointerdown/touch drawing focuses the canvas without scrolling; keyboard users may Tab directly to the canvas. Keyboard shortcuts do **not** send commands to the server or change the authoritative game state; pen, width, undo/redo remain consistent with existing toolbar state and R13o tab-scoped unsent draft.
- Scope shortcuts to `event.target === drawing canvas`; never intercept text/chat editing, contenteditable, select or button controls, IME composition, modifier shortcuts other than the documented Ctrl combinations, unrelated browser controls or auto-repeat. Only current author with editable, idle canvas may use shortcuts; waiting/submitted/spectator/REVEAL states cannot use them.
- The current R13l presenter hotkeys remain in local REVEAL focus mode only and do not conflict with authoring. No changes to existing role permissions, COOP immutable inherited lines, bounded shape strokes, runtime dependencies, APIs, database, or storage fields.
- Avoid programmatic fullscreen and global shortcuts; no auto-triggered submission, clear-all, or server mutation. Accessibility: announce brush changes via the existing tool hint (non-live to avoid chatter); preserve visible keyboard focus.

## Acceptance
- Static client contracts for focus-scoped keyboard, IME/repeat/modifier gate, tool mapping, width mapping, shared undo/redo click paths and original presenter shortcuts.
- Real Chrome/Edge NORMAL+COOP multi-member E2E: focus canvas and activate L/R/O/B/E, width values 1/2/3; commit a keyboard-selected shape via touch, undo/redo with Ctrl shortcuts, verify byte-for-byte local image recovery, saved canonical stroke color/width and unchanged server submission/reveal until user presses submit. Verify text input in NORMAL, anonymous spectator and outside-canvas focus cannot trigger author shortcuts. Post-submission keyboard actions denied; presenter keys retained. Mobile 390px canvas has no horizontal overflow.
- Run all R1–R13p probes and Windows x64 package verification on exact proposed head. Keep stacked Draft.
