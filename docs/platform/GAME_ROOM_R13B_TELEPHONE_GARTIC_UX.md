# R13b — telephone drawing-and-writing mode (Gartic Phone-inspired)

**Project:** GameCenter / Drawing Guess shared GameRoom
**Branch:** `feature/common-game-room-r13b-telephone-flow` (Draft, stacked on R13a #56).

## Reference UX and intentional differences

Official Gartic Phone describes its **Normal** preset as simultaneous player-written sentences passed to other players as drawings, followed by drawings passed again as text descriptions, with all of a player's chain revealed later in an album. See [official HOW TO PLAY](https://garticphone.com/en/book) and [official modes](https://garticphone.com/ko/lobby). We borrow the **interaction sequence**, not trademark, screenshots, artwork, or identifying visual assets.

- **Lobby:** unchanged anonymous guest join, optional account advantages, separate PLAYER vs SPECTATOR, total room-member capacity, room chat and host start. Add the `전화 그림 · 문장→그림→설명` mode; requires 3–12 ready players.
- **Stage 1 — WRITE:** every player simultaneously writes their own short quirky sentence. Private to that album.
- **Stage 2 — DRAW:** each participant receives a DIFFERENT predecessor sentence; only that artifact is visible to them. Touch/pointer canvas, color selector, three brush widths, eraser, undo and submit button; text is hidden from other players. Canonical stroke color/width survives in the album.
- **Stage 3 — DESCRIBE:** the next participant gets the predecessor's drawing with no original sentence, and types what they think it means.
- **Subsequent stages:** continue alternating until each album has visited all players. Each of N frozen players authors exactly one stage in each of N concurrent albums.
- **Waiting/timeout:** after submission, show progress count and nonblocking "waiting for others" screen. All N submissions advance the stage atomically; an expired stage inserts typed placeholders for missing submissions and advances when the next authorized poll/submit occurs.
- **Reveal:** only after the final stage does any participant or spectator receive album content. Show one original-author album at a time, with the complete alternation and each author labeled. Output safely via textContent and bounded canvas stroke rendering.
- **No forced score:** telephone mode does not award scored Drawing Guess points or treat a description as a scored correct answer. Existing Drawing Guess, R13a streamer rotation, chat scoring, channel grants and TTS are unchanged.

## Authority and persistence

- One normalized common GameRoom is the membership authority. Only connected, joined, frozen PLAYER member bearer can submit a phase. Browser cannot specify album index, author identity, stage number or previous artifact.
- Assign chain `albumSlot = (myFrozenPlayerSlot - stage + playerCount) mod playerCount` in SQLite; prior stage always belongs to the previous player. Viewer receives only THEIR preceding artifact. All albums are revealed when stage=N.
- DB migration V41 creates `game_room_telephone_match`, `game_room_telephone_player` and `game_room_telephone_entry` to persist stable roster, private submissions, deadline, current stage and completed albums. Each submitted item has a unique `(room_id, album_slot, stage)` and is committed with stage progress in one writer transaction.
- Text limited to 180 characters. Drawings are canonicalized to bounded stroke arrays with unit-box coordinates, validated hex color and 1–24px brush width; max 100 strokes, 96 points per stroke and 180 KB JSON. The telephone submission HTTP body has its own 180KiB bound instead of the general 8KiB control-action bound. Browser submissions include an exact stage number so stale/late posts never write into the next phase. No HTML, CSS, external image sources, executable SVG or user-provided author aliases are trusted in canvas content.
- Timeouts are 30–600 seconds per stage; expiration is lazily reconciled by an authenticated room state fetch or submission. This is not a wall-clock background scheduler.
- Reconnecting with the same authorized room session restores current stage. Existing kick/session-revocation protections remain. The completed album persists after restart.

## R13b boundaries

- This follows **Gartic Phone Normal**, not collaborative "continue the same drawing" mode. A shared-canvas/Complement-like mode is separate; it needs append-only canvas handoff, owner-fencing and explicit mode selection rather than treating drawing and text interpretation as the same mechanic.
- First version includes an adjustable colored brush, eraser, undo and clear. Further UX follow-ups may add fill bucket, shapes, zoom, stroke replay, animated export, timed phase notifications and host-controlled album slideshow. The existing scored Drawing Guess remains a distinct mode.
- The R13a multi-streamer authorized drawer roster remains available for scored rotation; it is not required for telephone mode. This preserves anonymous player parity and does not imply verified SOOP account ownership.

## Gates

- Build & V41 backup migration probe, private prompt isolation, one submission per phase, spectator denial, immutable n-way routing, bounded draw data, deadline transition and after-reveal persistence probes; JS/Chrome/Edge E2E and Windows packaging.
- No automatic merge/release. Real SOOP multi-account connectivity and identity attestation remain outside offline regression.
