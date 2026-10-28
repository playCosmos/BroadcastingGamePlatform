# R14b — Common GameRoom reconciliation ownership audit

**Parent:** R14a Draft PR #83, exact-head verified at `898d3e580d75b209e02e445007d1515b0f95078b`. **Delivery:** stacked Draft; no merge or release.

## Audit and scope decision

Drawing and Yacht use the same membership API but retain separate game-specific controllers. The repeated pieces are simple (an immutable initiating bearer, member generation, admission/member action locks, last-request-wins directory epoch, and guarded WebSocket callbacks). Their refresh and rendering mechanics **are not equivalent**: Drawing composes native snapshot + telephone reveal + canvas + host channels while Yacht composes room + dice/score state, and their UI teardown differs. A new runtime shared script would add a load-order dependency and require touching both already-tested clients for little net code reduction. **R14b intentionally introduces no shared production module.** Each lifecycle remains locally traceable in one controller. Duplicate request-epoch checks are small and preferable to moving a handful of lines to a third file.

## Two concrete defects

1. In both clients, a chat read begun in one active membership was correctly fenced against another membership, but not against a **newer GET in the same membership**. WebSocket-driven reads and write-triggered reads can overlap. A delayed older response could erase freshly received messages or edit/deletion results. Each chat GET now captures a monotonically incremented `chatReadEpoch`. Its result is rendered only if the epoch and initiating member are still current. Both member accept/clear paths invalidate pending reads.
2. In Drawing, an old room's pending snapshot GET left the shared `refreshBusy` flag set. Joining a different room called `refresh()` but only queued a rerun behind that older GET, potentially leaving the newly accepted room stuck on its loading placeholder indefinitely. R14b makes the refresh lock owned by a `refreshGeneration` and detaches the old lock/rerun on acceptance and teardown. A late old GET's `finally` cannot unlock or schedule work for a newer membership.

## Responsibility and cognitive distance

| Boundary | Drawing | Yacht | Share? |
|---|---|---|---|
| Membership generation and bearer | `room.js` `accept/clearMembership`, `request` | `yacht.js` `saveSession/clearSession`, `request` | Same contract, but local implementation remains obvious |
| Pending refresh ownership | `refreshGeneration` + `refreshBusy` | `runningGeneration` + `running` | Same invariant; different multi-read pipelines |
| Same-member chat ordering | `chatReadEpoch` in `refreshChat` | `chatReadEpoch` in `refreshChat` | Tiny local guard, no added shared runtime |
| Public room listing order | `publicRoomsEpoch` in `loadPublicRooms` | `publicRoomsEpoch` in `loadPublicRooms` | Existing last-result-wins contract |
| Game-specific display and sockets | Drawing/telephone/canvas/channels | Yacht dice/score/realtime | Keep separate |

## Automated acceptance gates

- Client contract probes assert both same-member latest chat results, detachment on member switch, Drawing refresh lock generation and a fenced `finally`.
- Real Chrome/Edge E2E in the existing Drawing and Yacht fixtures holds one authenticated `/chat?after=-1` GET, submits a real new chat message to cause a newer fetch, then releases an old synthetic empty response. The new message must remain rendered.
- A Drawing real-browser test holds one prior member `/drawing` snapshot GET, admits another hosted room through the same tab, verifies new-room rendering **before** the old GET resolves, then releases a synthetic 403. The new membership must survive.
- All existing platform regression probes, Drawing telephone NORMAL+COOP, Canvas, Yacht match and Windows x64 package checks must pass on exact PR head.

## Remaining integration risk

Physical-device mobile behavior and external-network multi-streamer use still need separate acceptance. Do not assert complete product release readiness based on deterministic CI alone. Any later shared client service should be justified by an actual third consumer, reduced code, clear ownership semantics, and no increase in developer file-hopping.