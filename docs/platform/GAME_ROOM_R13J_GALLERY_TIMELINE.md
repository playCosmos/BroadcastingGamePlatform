# R13j — Host-controlled telephone reveal timeline

**Stack:** Draft R13j on R13i #65 (`feature/common-game-room-r13i-stroke-replay`). R13d/f's server-owned presentation is authoritative.

## Experience
- In REVEAL, list every completed album and the ordered stage labels of the selected album in a small, responsive timeline. Expose the same current album/step to host, players and spectators, including the first slide, page reload, room WebSocket catch-up and autoplay ticks.
- The authenticated room host can select a specific album (starting at step 1) or a specific stage within the presented album. All clicks use existing, revision-fenced `POST /drawing/telephone/present`, never a browser-local cursor mutation.
- Players and spectators see the same current marker but cannot issue navigation. During automatic host slideshow, all manual navigation controls including timeline are disabled; paused slideshow restores host access.
- Avoid rebuilding the entire timeline on every polling snapshot: keep DOM button identity, focus and click targets stable when album structure is unchanged. Reflect pending presenter transactions as disabled controls.
- Every list item uses `textContent` and carries stage/album position in fixed numeric DOM datasets. Long/untrusted author names are never inserted as HTML. Keyboard focus and pressed/current state are accessible.
- Preserve previous/next controls, R13h complete PNG export, R13i local stroke replay and their cross-client isolation. Host jump changes the authoritative slide and therefore cancels obsolete local replay on other devices.
- No new API endpoints, schema changes, extra dependencies, merge or release.

## Verification
- Static Drawing room contract asserts server-authoritative timeline, spectator permissions, autoplay/presenter locks and DOM-safe list building.
- Real Chrome/Edge NORMAL and COOP browser suites: three entries per album, viewer markers on authenticated spectator and player, spectator click cannot navigate, host album jump and stage jump synchronize to all devices with monotonic server revision, same-slide refresh preserves timeline DOM identity and autoplay disables jumps. Existing replay/export/host pause checks remain intact.
- Full R1–R13i platform probes and Windows x64 package verification must pass against the exact proposed head.
