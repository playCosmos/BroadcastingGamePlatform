# R13k — Telephone reveal focus mode for hosts and spectators

**Stack:** Draft R13k on R13j #66 (`feature/common-game-room-r13j-gallery-timeline`). Retain all existing server/authorization contracts; no new dependencies, API routes, migrations, or background process.

## User experience
- After a NORMAL or COOP telephone match reaches **REVEAL**, every authorized host/player/spectator can independently enter `집중 보기`. The page emphasizes the currently shared stage with a dark, wide, streamlined presentation layout suitable for screen capture, a second monitor, or a stream.
- Focus mode is **local only**. The host's server-authoritative album/step cursor, playback timing and revisions remain the single source of truth; focus toggling must never send a mutation request or trigger a new identity.
- Hide lobby, scoreboard, chat, room metadata and the site's header/notice **only while focus is active**. Retain the current stage title, album and step position, and previous/next/manual slideshow controls for host; the buttons remain permission-fenced. Hide the timeline and PNG download controls in focus mode to reduce clutter, but restore all controls on exit.
- No native browser fullscreen permission requirement. Offer a visible exit button and `Escape` for leaving focus. Keep focus state per tab in memory, never in localStorage/sessionStorage or the URL. Access before REVEAL has no effect.
- A polling refresh, WebSocket replay, or host slide navigation should update the visible stage **without exiting** focus. R13i local stroke replay remains available. Leaving/closing the room, phase changes away from REVEAL, and reload must reset focus mode.
- Use responsive CSS and respect small (~390px) mobile viewports; no horizontal overflow. Maintain accessible `aria-pressed`, descriptive labels and visible keyboard focus.

## Verification
- Extend static UI contract to check reveal gating, CSS scoping, Escape exit, and absence of network/identity changes in local toggle.
- Real Chrome/Edge NORMAL and COOP full-game E2E: pre-reveal denied, spectator focus hides unrelated panels but retains full current slide and read-only presenter controls, refresh/host navigation preserves focus, Escape restores the original room layout; authenticated host can enter/exit focus and still navigate. Verify revision and identity remain unchanged by toggling, and 390px mobile viewport has no overflow.
- Existing R1–R13j platform probes, real-browser acceptance, Windows x64 artifact build/verification, exact-head CI remain release gates.
- Keep the stacked pull request Draft; do not merge or tag a release.
