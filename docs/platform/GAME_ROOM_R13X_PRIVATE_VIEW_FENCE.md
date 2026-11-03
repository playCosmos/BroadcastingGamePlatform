# R13x — Native room private-view teardown and prompt response fencing

**Parent:** R13w Draft PR #79, exact verified SHA `a4ccebc0e5f3e75d2d8f19dfa9bb8aef066fdc16`.

## Verified risk

The R13w telephone actions and native drawing queue fence asynchronous work, but
`room.js` still retained the previous member's native drawer answer,
invite URL, host room identifier, score and roster DOM until the next
`/drawing` GET returned. `accept()` makes the new room visible before that
GET, so a slow/hung response can expose old-room secrets in the replacement
room. Separately, `loadPrompt()` used the mutable current bearer and its
unscoped error handler could display a previous room's failure after the
membership changed.

## Contract

- `clearRoomBoundViews()`, used on both admission and teardown, clears the
  prior room's private drawer word, invitation text, host identifier, roster,
  scoreboard and labels, clears unsent prompt/guess/chat/broadcast-grant form
  fields, hides the previous privileged/game panels and resets
  `roundWordId`. During admission the heading communicates that authoritative
  room data is loading, rather than displaying a previous room.
- `loadPrompt()` accepts the immutable generation and bearer captured when
  its round view was rendered. The read is authorized with that bearer;
  after the await, session *and round* are both checked before publishing the
  private answer. Delayed errors are silent for a replaced membership.
- Keep the existing session privileges, room/join APIs, private-draft rules,
  guest parity, and R13w presentation fencing unchanged.

## Acceptance

- Static contract tests cover all private/host panel reset targets, prompt
  bearer pinning, response and error guards.
- Real Chrome/Edge NORMAL and COOP browser scenarios seed an old room's
  private answer and invitation, hold the replacement room's first
  authenticated `/drawing` GET, and verify old text and host controls are
  cleared *before* the next server render; then release the GET and verify
  the replacement room fully reconciles.
- Run all existing browser/HTTP regression probes and Windows x64 build and
  packaging at the exact PR head. **Draft only; do not merge or release.**
