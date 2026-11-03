# R13c — collaborative drawing and step-by-step album reveal

**Stack:** Draft PR on R13b #57 (which is stacked on R13a #56). Do not merge/release before exact-head Windows CI and dedicated browser acceptance.

## Two deliberately distinct Gartic-inspired game modes

- **NORMAL** (R13b): WRITE → DRAW → DESCRIBE → repeat. Each of N players contributes to one of N simultaneous private albums per stage, then all completed albums reveal.
- **COOP** (R13c): DRAW → DRAW → DRAW. Each player starts one canvas, then passes it to the next participant in frozen ring order. **All existing strokes carry forward**. Each author adds only their own strokes. The stage after N turns reveals N albums, each containing a snapshot for every turn. There is no simultaneous shared document write or browser-selected editing owner. Works with existing anonymous GameRoom PLAYER/SPECTATOR roles.

## Immutable, server-authoritative Canvas ownership

The original GameRoom telephone match's `mode` column (V42, default `NORMAL`) is fixed once the host starts the game and validated on retry; legacy R13b games are unchanged. The server uses the existing N-player roster to determine which album belongs to the current member; neither album slot nor author is client-controlled. During a COOP stage only the assigned, connected player can submit a bounded set of **new strokes**. The server reads the preceding authorized snapshot from SQLite and appends the new stroke array inside the same `BEGIN IMMEDIATE` transaction as the submission and phase advance. A client cannot delete, replace, or rewrite prior artists' strokes: erase, undo and clear operate only on the local, not-yet-submitted overlay.

To constrain storage, all drawing stroke arrays remain canonical point/color/brush-width data, with at most 100 new strokes per turn, a maximum of 300 cumulative strokes per album, 96 unit-coordinate points per stroke, and 180KB stored JSON per snapshot. An empty new-stroke submission is valid in COOP and preserves the inherited canvas; normal drawing continues to require a nonempty stroke. Under timeout, COOP carries forward the last snapshot rather than replacing it with an empty canvas. An expired stage is reconciled on authorized request (not a background timer). Existing exact-stage request guards, one-submit-per-stage uniqueness, no-login parity, spectator privacy and private read ACLs continue unchanged.

## UX / slide reveal

The Drawing Guess lobby adds a distinct **협동 이어 그리기** option alongside the R13b written telephone mode, stream-based rotations and the scored drawing mode. The COOP drawing board renders the previous author's verified snapshot beneath a separate editable local overlay. A separate preview is used only for NORMAL's describe phase; it does not create a second drawing surface in COOP. The guide explains that prior artwork cannot be erased. Completion retains separate albums with author names and ordered snapshot stages. Reveal now starts with **one slide**, supports previous/next *step*, and previous/next *album* resets the step to the first frame. All received fields are rendered as text or bounded normalized canvas commands; none is inserted as HTML.

## Compatibility, verification and next gaps

- V42 schema migration and the iterative backup pre-migration fixture; NORMAL remains default for existing rows/old clients.
- New R13c server probe exercises frozen mode, unauthorized spectator, append-only history, previous author privacy, stale-phase fencing, SQLite restart, reveal and immutable final albums.
- Chrome/Edge dedicated, real-browser four-user game flow runs both NORMAL and COOP from guest creation through stage completion, real touch canvas strokes and slide navigation. Existing legacy E2E and all earlier regressions remain gates.
- **Not yet:** automated host-directed slideshow synchronization across devices, pause/replay animations, drawing palette upgrades beyond R13b brush, real SOOP multi-account broadcaster identity proof, or live-stream staging. These are separate milestones.
