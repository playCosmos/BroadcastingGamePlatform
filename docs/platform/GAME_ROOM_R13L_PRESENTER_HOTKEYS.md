# R13l — Presenter keyboard shortcuts for telephone reveal

**Stack:** Draft on R13k #67 (`feature/common-game-room-r13k-presentation-focus`), preserving R13d–j authoritative cursor and autoplay.

## Contract
- Shortcuts are **opt-in to locally activated focus mode** in finished NORMAL/COOP REVEAL. Only the authenticated host may use them. Every other member can use local focus/Escape but not navigation or server playback shortcuts.
- Focused host keys: **← / →** previous/next step within the current album; **PageUp / PageDown** previous/next album (start at first step); **Space** start/pause the existing server-controlled slideshow. Escape exits focus (R13k).
- All commands call existing revision-fenced host `present` and `playback` methods. Never change local cursor optimistically or write another endpoint.
- Manual navigation shortcuts do nothing during autoplay; Space is the host's only playback toggle, which remains available during autoplay. Boundary keys do nothing at the first/last step or album. Guard each command during an in-flight presenter mutation and against key repeats.
- Never intercept typing, text fields, selection widgets, buttons, contenteditable targets, browser shortcut modifiers (Ctrl/Alt/Meta), or IME composition. Shortcuts have no effect outside local focus or before REVEAL. Entry to focus puts keyboard focus on the reveal container so users can operate without another click; Escape returns focus to the focus button.
- Display shortcut help for the host while focused. Spectators see only Escape instructions. Keep active focus state ephemeral, per tab; preserve R13h export, R13i replay, R13j synchronized timeline and R13k responsive focus.
- No dependencies, schema changes, added server routes or permissions.

## Tests
- Static Drawing-room checks for scoped key handlers, authorization, repeat/IME/modifier/typing guards, and reuse of server-authoritative actions.
- Real Chrome/Edge NORMAL+COOP multi-member browser tests: pre-reveal key ignored, spectator shortcut denied, host focus arrow reverse/forward, page album jump and reverse, boundary and modifier/typing denial, Space play/pause and autoplay manual lock, monotonic committed revisions with spectator synchronization, Escape exit and nonfocus denial.
- All R1–R13k probes, Windows x64 package and artifact upload on exact proposed head. Remain stacked Draft; no merge or release.
