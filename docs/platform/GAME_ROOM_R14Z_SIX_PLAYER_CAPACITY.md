# R14z — Common GameRoom upper-limit integration (6 players + 14 spectators)

**Stack:** Draft R14z on verified R14y PR #107 (parent exact HEAD `7e459a3fd22b57c7b26f6d4712944665967dee7b`). This adds only an acceptance scenario, no runtime/API/schema changes or release.

## Gap and scope

R1 validated `maxPlayers=6` and `maxRoomMembers=20` with concurrency and member-role transitions at the domain/SQLite boundary. R4 verified a **2-player, 26-turn** real common-room Yacht match with spectator HTTP access. R14y proved **2-player, 26-turn** completion in the packaged Windows JVM and real Chrome/Edge. None of those combined **six actual players and fourteen distinct spectators in one room** through the complete 78-turn Yacht match in real HTTP.

R14z extends the existing disposable `GameRoomYachtR4HttpProbe` against its real `GameClientHttpServer` and SQLite instance, with independent ADMIN-authorized room creation and ephemeral membership tokens.

1. Create a separate `yacht` room with `maxPlayers=6`, `maxRoomMembers=20`, host using the PLAYER seat; host counts **once**, never twice.
2. Admit five different PLAYER identities using an invitation, then reject a **seventh** PLAYER with HTTP 409 *even though total member capacity is not full*.
3. Admit fourteen different SPECTATOR identities. Verify exactly twenty distinct members (6 PLAYER + 14 SPECTATOR), all within one room. Reject the 21st member with HTTP 409 while a spectator invitation is still valid, and reject spectator-to-player seat promotion while all six PLAYER seats are occupied.
4. Require all six players to mark ready, reject spectator start, start the match as the host and ensure all six members are locked as the actual match roster, not spectators.
5. For each of **78** server-authoritative score commits, read the live state as a spectator, identify the actual active player, roll server-controlled dice as that player, choose a category from `availableScores.points` (respecting Joker legal choices), and commit with matching optimistic version. Assert player turn rotation, match identity, version advance, score count and room lifecycle. Challenge spectator and non-active-player roll ACL at first and last turns.
6. Every one of fourteen viewers must independently read the final `FINISHED` / `POST_GAME` game, all six finalized scorecards with thirteen distinct categories, and unchanged **20-member / 6-player** room capacity.

Required marker: `GAME_ROOM_R14Z_SIX_PLAYER_CAPACITY_PASSED players=6 spectators=14 members=20 turns=78 scoresPerPlayer=13 postGame=true`.

## Verification boundary

This executes on the actual Java HTTP listener with disposable SQLite, not on a production service. The Windows CI runs the regular Java regression probes before packaging; R14z is **not** an external multi-PC or public HTTPS/WSS test and **not** a six-player packaged EXE or visual GUI demonstration. It exercises actual REST authorization, room membership, match state, persistence transactions, and spectator read access. No real stream accounts, internet endpoints or customer identities. PR remains Draft, unmerged and unreleased.
