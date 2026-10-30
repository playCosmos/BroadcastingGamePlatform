# R14w — Actual packaged localhost TLS trust negative controls

**Parent:** R14v Draft PR #104, exact prior verified HEAD `1ef775a97b38916553ee26a1a11125aa2ef893d7`. This branch is stacked and remains Draft, unmerged and unreleased.

## Purpose

R14v proves that two real authenticated Yacht members can use the existing R14u HTTPS/WSS client through an ephemeral localhost certificate and actual Windows packaged JVM. R14w adds **negative trust-boundary controls** against that same live, isolated Windows fixture TLS listener. A successful handshake with an explicitly provided local test CA is not enough by itself: **an untrusted CA and a valid CA with the wrong requested DNS name must both fail**.

## Test sequence, executed on each of two packaged JVM lifetimes

Inside `smoke-packaged-local-tls-client.ps1`, after the ephemeral 127.0.0.1 TLS proxy is listening and **before** starting the two-player R14u client, invoke `verify-packaged-local-tls-trust.mjs`. It performs three separate, new TLS handshakes:

1. **Positive control:** request `localhost`, explicitly trust only the freshly generated certificate, require `authorized=true`.
2. **Negative trust control:** request `localhost` with an explicitly empty CA list; require a concrete certificate-chain rejection. A successful connection fails the test.
3. **Negative identity control:** trust the generated certificate but request the unrelated SNI name `r14w-unexpected-host.invalid`; require `ERR_TLS_CERT_ALTNAME_INVALID`. A successful connection or a different failure fails the test.

The verifier explicitly enables Node's TLS verification. An inherited `NODE_TLS_REJECT_UNAUTHORIZED=0` setting is rejected. All three connections are to **127.0.0.1**, regardless of SNI. The verifier sends **no HTTP, WebSocket, token, room identifier or game command** and never connects to the public network. It does not install the ephemeral CA into an OS certificate store. Error reporting uses fixed markers and no certificate, credential or endpoint details.

Two preflight trust checks are required in each of the two real packaged JVM lifetimes, for **six TLS handshakes total**. Failing either lifetime aborts the original packaged run before the corresponding R14u field-style operation. Existing R14v final evidence remains unchanged and cannot be written as a successful result if a trust negative control fails.

## Gates

- `node --check ./verify-packaged-local-tls-trust.mjs` in both Windows package and manual release verification stages.
- `check-integration-workflows.ps1` blocks accidental removal of the checker invocation, nonzero-exit failure handling, expected negative controls, or workflow syntax gates.
- Actual Windows packaged fixture must emit `GAME_ROOM_R14W_PACKAGED_LOCAL_TLS_NEGATIVE_PASSED launch=1 checks=3` and `launch=2 checks=3`, then pass the unchanged R14v acceptance and earlier R14r–t tests.
- Independent local test of the Node checker can be performed against an isolated self-signed localhost HTTPS fixture. This is **not** equivalent to the Windows packaged test.

## Limits

This checks TLS chain and hostname rejection **only against an ephemeral localhost termination proxy**. It is not public CA trust, an external HTTPS/WSS test, a physical distributed multi-PC session, CORS/reverse-proxy production config, simulated packet loss, signed installer/upgrade, 24-hour field availability or memory-leak proof. The operator-only external test from R14u and the R14o–q field observers still require supervised real remote execution with distinct disposable test users and credentials. No production/API/SQLite schema changes.
