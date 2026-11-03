# R15g — twenty real Chrome/Edge Yacht browser contexts at the existing 24/IP WebSocket cap

Parent: verified R15f Draft PR #114 at exact commit `59c534df01bdbe3e3f8ddec934cf032fbee0dff3`.

## Previously unverified

R15a/R15f exercised **seven** actual Chrome/Edge browser contexts (six Yacht players and one spectator), with another thirteen spectator identities created via authenticated HTTP requests. R15e proved twenty actual native WebSocket clients with real Windows packaged EXE but used Node WS clients, not full browser pages. Neither proved that twenty independently running Yacht browser instances at one IP could enter, maintain authenticated live subscriptions, and render all game/chat UI updates without exceeding the unchanged 24 connections/IP limit.

## R15g actual browser acceptance

Extend the existing, mandatory, disposable Windows Chrome/Edge DevTools E2E fixture. Do not create a second server or test suite.

1. Six distinct real Chrome browser contexts create/join as PLAYER and one as SPECTATOR using ordinary public forms. The host obtains **one real, bounded 13-use SPECTATOR invitation** through the normal protected API.
2. Thirteen more **independently isolated Chrome/Edge browser contexts** join as SPECTATOR through the production `joinRoom` invitation form, in place of the previous HTTP-only spectator identities. This produces **20 real browser contexts total** (six players, fourteen spectators), with twenty distinct per-tab bearer credentials and actual `memberRoomId` sockets. No public-join quota, auth, or connection limit is relaxed.
3. The existing pre-document CDP observer on native WebSocket verifies exactly **one authenticated member room socket per context**, no redundant `yachtCode` socket. All twenty stay within the server's same-IP 24 socket limit.
4. Complete the existing full 78 authoritative Yacht score turns. Verify both native committed events (`yacht.dice.rolled` and `yacht.score.committed`) in correct order and version/turn number **on all twenty actual browser sockets**, totaling **156 × 20 = 3,120 native browser event deliveries**. This is in addition to R15e's independent packaged Windows Node/WebSocket evidence.
5. Verify all twenty independent browser pages render the completed six-player scoreboards, correct 20/20 room and 6/6 player membership, disabled controls, and the same committed postgame chat message. The existing spectator's deliberate WebSocket disconnect/reconnect must replay missed chat through its ROOM cursor (not native Yacht sequence) while retaining its original member credential. Remaining thirteen additional spectator connections must remain alive.
6. Existing seven-browser R15f acceptance, full-game, connection revocation, room chat, browser reload, TLS and R15b–e Windows packaged EXE acceptance remain required unchanged.

Expected marker:

`GAME_ROOM_R15G_BROWSER_TWENTY_MEMBER_PASSED players=6 spectators=14 browserContexts=20 memberSockets=20 nativeEvents=156 nativeDeliveries=3120 uiFinal=20 reconnect=1`

This is a test-only extension of `server/game-room-browser-e2e.mjs`, already a mandatory Windows Push/PR packaging and explicitly initiated release gate. No product code, schema, API, WebSocket cap or existing runtime behavior is changed. The test uses 20 isolated contexts inside **one** automated Chrome/Edge process over disposable localhost, not 20 physical devices, not public WAN/multi-PC/NAT field testing. Credentials, invitation values and raw chat/game payloads are not published as evidence. Keep Draft, unmerged and unreleased until exact-head Windows Push and PR CI verify the marker.
