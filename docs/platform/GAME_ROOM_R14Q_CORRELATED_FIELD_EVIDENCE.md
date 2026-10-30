# R14q — Correlating Windows JVM and external WSS field observations

**Parent:** R14p Draft PR #98, verified head 68d0f1cf2b31f4d8f160923ca82ae21ed1bd1f43. R14q remains a separate stacked Draft, with no merge/release and no production changes.

## Goal

R14o independently records Windows app-image server JVM resource counters. R14p independently records external HTTPS/WSS member reachability and reconnect outcomes. Neither source report embeds identifiers that link its machine, domain, room or process to the other. R14q is an **offline UTC time-window correlation** tool; it does **not** certify that two files belong to the same deployment, that clocks were synchronized or that a WSS failure was caused by memory pressure.

R14q reuses the complete schema/24h validity checks from both existing analyzers rather than accepting a loosely parsed summary or fabricated counts. R14o and R14p standalone analyzers remain supported.

## Running on completed field reports

First run the separately documented R14o Windows observer **on the actual server** and R14p external multi-member HTTPS/WSS observer **on another authorized test machine** for the same intended period. Record the host, package version, server deployment, proxy and time-sync verification *separately in a restricted operator session log*. Both files must have their native completion records; interrupted runs cannot be used for a completed R14q result.

After copying the two already-produced JSONL reports to a secure local analysis machine with Node 22+:

    node ./server/analyze-correlated-field-evidence.mjs --self-test
    node ./server/analyze-correlated-field-evidence.mjs --jvm=D:\GameRoomField\server-24h.jsonl --wss=D:\GameRoomField\clients-24h.jsonl --summary=D:\GameRoomField\combined-new.json

The default requires **each independent source to cover at least 86,400 seconds (24 hours)** and the actual overlap of their UTC observation timestamps to cover **at least 82,800 seconds (23 hours)**. The hour difference allows a modest setup stagger; it is *not* a substitute for 24h of each source. Each source's observed wall-clock duration must agree reasonably with its monotonic elapsed time. Large clock skew, mismatched windows or a different deployment must not be disguised as successful correlation.

For a **synthetic/local short smoke only**, an operator may explicitly lower both thresholds. Example for independently valid 120-second reports:

    node ./server/analyze-correlated-field-evidence.mjs --jvm=D:\GameRoomField\server-2m.jsonl --wss=D:\GameRoomField\clients-2m.jsonl --summary=D:\GameRoomField\combined-2m-new.json --min-duration-seconds=60 --min-shared-seconds=60

This does **not** meet 24-hour acceptance. Both source files are subject to their original strict schemas, full expected samples, complete footer, process/TLS provenance flags, failure accounting, no-secret allowlists and schedule checks. R14q also verifies the genuine shared UTC time span and the pairing of both sampled series.

## Result interpretation

The write-once, operator-local sanitized JSON summary records:

- independently validated total JVM samples and external WSS rounds;
- actual shared UTC start/end, overlap duration, paired time windows;
- per-time-window JVM working-set/private memory, thread/handle peaks and CPU delta, alongside external member checks, WSS snapshots, clean closes, failures and worst round p95 latency;
- whole-report JVM first/last/min/peak and observed resource deltas, plus WSS total failures and the **independent** zero-failure predicate.

**full source completeness is NOT service availability.** A complete external WSS report can have nonzero failures; R14q does not discard them or label them as a success. Conversely, zero observed failures means only these discrete checks succeeded; it cannot prove uninterrupted 24-hour connectivity between poll instants. Correlated high memory/handle values and connection errors within the same hour are **contemporaneous observations only**, not evidence of causation or leak freedom. The summary explicitly states that same-deployment identity is not cryptographically verified.

Raw field reports contain UTC timestamps and resource counters; this is internal diagnostic data, not safe to publish indiscriminately. The analyzer does not contact the server, make network requests, read secrets or upload field data anywhere. The result is created with a **new output file** and must not overwrite an earlier analysis.

## CI and outstanding acceptance

Windows package CI and manual release workflow run only JavaScript syntax checks, normal upstream R14o/R14p analyzer self-tests, and R14q **synthetic complete, partial, shifted-window, corrupted, failure-bearing and inconsistent-clock fixture tests**. The hosted CI never runs an actual 24-hour job, accesses a real field report, or reaches an authenticated external server. Passing CI proves the analysis tooling works, **not** that any real field run occurred.

A later stage should separately validate **real chat writes, durable replay, actual game actions and continuous user sessions** on isolated test systems. R14p is a periodic, read-mostly reachability probe, and R14q adds no load. Actual operator acceptance still requires physical Windows PC, external network/CA proxy, test members, clock-sync verification, 24h reports, installer signing, upgrade/rollback and tray interaction evidence.

Do not merge or release these staged Draft PRs as an unintended side effect of field observation.
