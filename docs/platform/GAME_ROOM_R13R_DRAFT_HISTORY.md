# R13r — Restore private drawing history and brush state

**Stack:** Draft R13r on R13q #73 (`feature/common-game-room-r13q-author-hotkeys`). Existing R13o privacy model and server-owned phase state remain authoritative.

## Problem
R13o restores only the visible unfinished strokes on same-tab reload. Undoing the last stroke removes the stored draft, so a reload destroys the remaining redo operation. Even with visible strokes, refresh loses undo/redo history and drawing tool, pen color, width and eraser selection.

## Contract
- Upgrade **drawing-only** tab-local draft payload to version 2 under the existing `gamecenter.telephone.private-draft.v1` sessionStorage key. Preserve legacy version 1 TEXT and DRAWING restore. Keep exact room ID/member ID/mode/stage/stageStartedAt scoping; never persist the inherited COOP base, prompt, bearer or finished album.
- Version 2 saves **current own strokes**, bounded per-gesture undo and redo snapshot stacks (up to 25 entries each) and valid pen mode/color/width/eraser flag. Every snapshot must validate against canonical 100 strokes × 96 normalized points, RGB color and brush width limits before restoration.
- Total serialized record size remains at most 900,000 UTF-16 code units; on overflow evict *oldest* history snapshots first, then fall back to current strokes and tool settings, without compromising current ink or abandoning privacy. Both empty-current-ink + redo and nonempty-current-ink + undo survive a reload. Do not autosubmit restored strokes or invent server state.
- Retain local draft even with empty current strokes when undo/redo history exists. Ignore malformed/stale/out-of-scope data. Submitted, expired, revealed, guest switch and room exit continue removing the draft. Explicit discard clears both current ink and history **without disabling later autosaves in the same stage**.
- Tool/color/brush changes save alongside existing draft, without changing underlying stroke serialization or server endpoints. Restore toolbar ARIA state and dropdowns correctly. Do not persist text-input history or any secret.
- No new APIs, dependencies, schema changes or browser-wide localStorage.

## Testing
- Static contracts for bounded history format, strict restore validation, snapshot eviction, version 1 compatibility, explicit discard and phase cleanup.
- Real Chrome+Edge NORMAL/COOP E2E: save two strokes/shapes, undo one, reload, check exact image and redo availability, redo, reload again, check undo availability, verify brush/color/tool. When all visible strokes are undone, reload must still retain redo. Discard must remove history, and adding a new stroke after discard must autosave.
- Run R1–R13q probes and the full Windows x64 packaging workflow on the exact PR head. Leave PR Draft, unmerged and unreleased.
