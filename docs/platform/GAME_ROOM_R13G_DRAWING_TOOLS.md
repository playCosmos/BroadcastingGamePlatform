# R13g — Telephone drawing tools and mobile interaction

**Stack:** Draft over R13f #62 (`feature/common-game-room-r13f-autoplay`). Preserve R13b NORMAL sentence/drawing relay and R13c COOP immutable inherited canvas. No server migrations, new third-party dependencies, merge or release.

## UX contract
- Make the active telephone drawing stage usable with a compact preset color palette plus existing custom color input and brush width selector. The selected preset is visibly/semantically marked; choosing a color deactivates the eraser.
- Add **undo and redo** for local, unsubmitted edits. New pen strokes, local-stroke erasures and Clear each form one undoable operation. Redo history is invalidated by a subsequent edit. Limit retained edit history to avoid unbounded memory; disable unavailable controls.
- In COOP, the inherited canvas is **read-only**. The eraser removes only this author's local strokes; undo, redo and clear never modify inherited strokes. In NORMAL the eraser retains the existing white-pen behavior. Keep payload schema/size/stroke limits as before; do not serialize undo/redo history.
- Handle pointer capture, cancel, primary touch only, and touch scrolling conflicts on the canvas. An interrupted gesture rolls back its partial local edit without submitting it. One tap must still produce a visible dot. Tools are disabled outside the active editable stage and during submit.
- Reset transient drawing state and history when the room/session becomes inactive or phase changes. A stale prior-room local draft must never appear in a newly joined room.

## Test gates
- Static Drawing room contract checks required controls, no unsafe HTML or new dependencies, and client ownership boundaries.
- Execute **actual Chrome/Edge** Normal and COOP three-player browser cases: palette, pen stroke, undo/redo, redo invalidation, clear restoration, pointercancel rollback, spectator restrictions, COOP inherited canvas preserved after editing, and server-side result integrity.
- Existing R1–R13f regression, V44 migration/backup, Windows packaging all remain gates. The CI commit SHA must exactly match the proposed head; do not claim a pass until it does.
- Maintain Draft PR and do not merge or release.
