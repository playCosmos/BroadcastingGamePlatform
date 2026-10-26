# R13o — private unfinished telephone draft recovery

Stack R13o Draft on R13n #70. Address the verified authoring-loss case: NORMAL text and NORMAL/COOP drawing are kept in memory across same-stage HTTP/WSS polling but lost when the page is reloaded before submission.

## Privacy and authority contract
- Only the current tab's `sessionStorage` may contain **the author's own unsubmitted input**: the typed sentence OR mutable drawing overlay strokes, never the assigned predecessor prompt, inherited COOP strokes, completed albums or bearer secret. No remote draft API, analytics, cross-tab sync, external dependencies or data migrations.
- Scope recovery to the exact authenticated `roomId + memberId + mode + stage + stageStartedAt`. Duplicate rooms, another member, another stage or expired/submitted/revealed rounds never restore the previous draft, even if the page was reloaded. Reject malformed, oversized, or unrecognized stored data. No restoration for spectators/waiting members.
- Save text on author input and own strokes on finished/canceled pointer gestures, undo, redo, clear, or eraser. Store a maximum of the canonical drawing 100 strokes × 96 normalized points per stroke; do not record the immutable COOP base. Preserve color/width that belongs to each saved stroke. Undo history itself is not durable.
- Submit success discards the recovered draft immediately, then normal room reconciliation remains server-authoritative. Submission failure retains it, allowing retry; a late server state showing already submitted or advanced also discards it. Logout/kick/leave/switch room discards storage.
- Show accessible status for auto-saved/restored state and an explicit **임시 저장 내용 버리기** action. Closing a tab drops tab-scoped data. Warn the author that drafts are tab-scoped, not uploaded and disappear after stage end.
- No changed game-room authorization or private prompt exposure; never silently submit restored input.

## Acceptance gates
- Static client contracts for identity/stage scoping, bounded validation, author-only persistence, no private predecessor, submit/room/phase cleanup and explicit discard.
- Real Chrome/Edge NORMAL and COOP: refresh during first author stage with unsent text or a drawn stroke; verify exact recovery and unchanged authoritative submission counts, bearer/identity, and predecessor privacy. Verify another member/spectator never receives the draft. Check same-stage polling preserves draft, and stage switch / successfully submitted state clears it.
- Retain full R1–R13n platform regressions plus Windows x64 package and exact-head CI. Keep stacked PR Draft; no merge or release.
