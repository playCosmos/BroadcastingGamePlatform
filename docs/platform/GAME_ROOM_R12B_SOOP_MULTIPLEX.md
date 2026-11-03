# GameRoom R12b — bounded SOOP multi-source transport

**Stack:** R12a Draft PR #52. This implements independent SOOP provider connections and per-stream diagnostics; it does **not** merge/ship any draft or grant provider ownership credentials to anonymous players.

## Existing single-stream compatibility

- `streamerId` at the root of `config.json` is still the **primary** source and the historical management/tray source. `soop.enabled` and `soop.offlinePollSeconds` retain their meanings.
- Optional `soop.additionalStreamerIds` is an operator-managed list (e.g., `["streamer_two","streamer_three"]`). A missing key from any older config resolves to an empty list without rewriting the file during load. Save/reload maintains the list.
- The server validates safe ID syntax, trims whitespace, rejects duplicates including the primary, and limits **all** connections to eight (primary plus extras). An empty primary and populated extras is valid.
- `SoopMultiBroadcastProvider` is registered once as the **SOOP** provider. It owns one `SoopBroadcastProvider` / `SoopBridgeAdapter` instance **per configured channel**. A source therefore has its own SOOP client, connection attempt/generation, offline poll clock, state counters, retries and shutdown.
- Existing `SoopBroadcastProvider` event conversion and `PlatformEventBus` subscriptions remain unchanged. Chat events enter R12a's bound-channel native Drawing Guess score engine; donations still reach board games. This avoids separate duplicated score pipelines.

## State, control and isolation

- The provider's existing top-level `streamerId`, `status`, `chatEvents`, `donationEvents`, `lastError` etc. refer to the **legacy primary** and are preserved for existing API consumers.
- The response additionally reports `configuredStreams`, `connectedStreams`, `aggregateStatus` and a per-source `streams` array, with `streamerId`, `primary`, `status`, `bno`, `title`, event counters and last error. Available through existing administrator-authenticated provider monitoring and local management UI state. The UI tray uses aggregate health.
- `reconnect()` remains the historical global manual reconnect. Each underlying source also implements separate automatic retry with independent SOOP SDK instances. `reconnect(streamerId)` is available for future **operator-only** targeted controls, but is not exposed as a public browser action.
- New sources are provisioned via trusted server configuration and cannot be created by an anonymous guest, a room's chat message, or the R12a room binding form. A configured source is **not proof** that a game-room host owns/controls that broadcaster account.

## Tests and current limitations

- New `SoopMultiProviderR12bProbe` uses disabled (no-network) real provider instances to verify unique connection identities, source budget, status projection, registry compatibility, repeated start/close, targeted reconnect bounds and persisted configuration. Existing config persistence regression also checks that old JSON yields no additional sources.
- R12a keeps its two-channel real round scoring and regression probes, and existing Chrome/Edge HTTPS/WSS browser game-room checks remain in CI.
- **Real simultaneous SOOP sessions are not verified by offline CI**; confirm SDK reentrancy, account and channel ownership/consent, upstream channel ID equivalence (`bid` vs provisioned streamer ID), server resource cost, and forced disconnect/rejoin on two authorized broadcasts in staging.
- R12a anonymous room hosts may bind channel *labels* through their host token without platform ownership authentication. The server operates only configured SOOP connections, but a separate **host-to-broadcast ownership or operator grant** mechanism must be finalized before production enabling external channel scoring. Do not present a room host's label selection as verified streamer ownership.
- R13 is a separate effort: multi-streamer drawer rotation, authorization handoff and continue-drawing canvas ownership. Neither is implied by this transport work.

## Acceptance gate

Exact-head Windows Maven build, existing regression probes, R12b offline supervisor probe, GameRoom browser E2E, Windows packaging and artifact upload are required. The R12b PR stays Draft pending evidence. A passing CI validates the configuration/lifecycle code path, **not** live SOOP multi-account operation or broadcaster consent.
