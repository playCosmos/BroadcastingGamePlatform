# R15f — Real Chrome/Edge single Yacht member socket, native event delivery, and reconnect chat replay

Parent: verified R15e Draft PR #113, head `769d11ebeb95e15b950647aa4adb53fa160c1f19`.

## Motivation and tested behavior

R15e fixed the actual common-IP socket budget: Yacht clients no longer open both an authenticated member-room socket and an unauthenticated native Yacht socket. Packaged Java/Node acceptance confirmed 20 member connections receive 3,120 native event deliveries but did not verify that **actual browser clients** use only one socket or preserve their room chat replay cursor when an unrelated Yacht version advances.

The existing mandatory Windows Chrome/Edge CDP fixture already starts **six independent Yacht player browser contexts and one spectator browser context** to complete one 78-turn game (the remaining 13 spectators are authenticated HTTP identities). R15f adds a page-scoped *observer* installed with CDP `Page.addScriptToEvaluateOnNewDocument`, before the real production Yacht scripts run. It wraps the native WebSocket constructor, preserving network behavior while recording only socket kind, lifecycle, room subscription cursor and sanitized event metadata in the disposable page memory. It does **not** substitute mock sockets or expose secrets in CI output.

1. Wait until all seven independent browser contexts have exactly **one opened authenticated `memberRoomId` WebSocket** with an actual `room.subscribe` command; no `yachtCode` or additional socket.
2. Play all 78 real game turns through the existing six real Chrome player contexts. Require each of the seven *browser-native* sockets to observe both `yacht.dice.rolled` and `yacht.score.committed` per turn — **156 ordered Yacht frames per browser, 1,092 frames total**, with matching committed sequence/version and completed-turn count.
3. Once game-event sequence is far ahead of chat event sequence, send a real committed host chat and require the spectator to observe it on the authenticated member socket. Close that **real browser socket**; commit a second chat while offline; require the browser's existing reconnect handler to open exactly one replacement socket with **the prior room chat sequence, not Yacht's game version**, and recover the missed chat message through the native server's durable `room.subscribe` event replay.
4. Require spectator's chat DOM to render the recovered message and preserve the original per-tab bearer. Existing R15a terminal UI assertions, final spectator page reload and all other browser integration suites must continue passing.

Expected marker:

`GAME_ROOM_R15F_BROWSER_SINGLE_SOCKET_RECOVERY_PASSED tabs=7 perTabSockets=1 nativeEvents=1092 reconnect=1 replay=1`

The required `Real GameRoom Chrome Edge browser E2E` gate already runs `server/game-room-browser-e2e.mjs` under **both Windows Push and PR packaging**. R15f extends that existing gate without adding a redundant second browser fixture, changing game server connection limits, altering production WebSocket code or publishing bearer tokens.

## Limitations

These are **seven actual browser contexts on disposable localhost**, not 20 visible game browser tabs or multi-PC/WAN/NAT testing. The previous R15e packaged 20-member Java/Node delivery test remains mandatory and complementary; R15f verifies browser behavior. Remain Draft, unmerged, unreleased. No deployment or publication.
