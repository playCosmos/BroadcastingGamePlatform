# R15i — GameRoom stacked-PR integration readiness and drift audit

## Verified snapshot — 2026-10-31

GitHub's open-PR collection contained **93 open PRs**, of which **81** form one contiguous Yacht/GameRoom **Draft** stack: **PR #33 (Y0 scoring, base `main`) through PR #116 (R15h)**. The remaining 12 open PRs belong to other feature lines. All 80 child-to-parent relationships in this stack reference the *current exact parent HEAD SHA*, and PR #33's base commit matches `main` at `62ed59928558431e5608e9194f034e53685ef69a`. This checks branch metadata, not code-level conflicts or real mergeability. It is a point-in-time observation, **not** proof that later ref updates or merges will be safe.

**Most significant risk:** the entire 81-stage stack is unmerged. CI success on the latest branch tests its cumulative tree but **does not** establish that 81 individual GitHub merges, squash strategies, deleted intermediate refs, or live rollout will work. Continuing to add another stage without an integration plan increases review and coordination cost.

## Live read-only lineage audit

The new `server/audit-game-room-pr-stack.mjs` only reads the GitHub public pull-request collection and `main` HEAD. It never merges, edits PRs, rotates credentials, or triggers a release.

In PowerShell with Node.js 22+ from the repository root:

```powershell
node server/audit-game-room-pr-stack.mjs --self-test
node server/audit-game-room-pr-stack.mjs --live
```

`--live` verifies that PR #116 remains the tip, PR #33 remains the root, all 81 required stages still exist as open Draft PRs in this repository, each PR base names the immediate parent's branch, each child's base SHA matches its parent's **current** HEAD, no duplicate PR numbers/heads or cyclic links exist, and the bottom main base SHA matches current `main`. `GITHUB_TOKEN` can optionally be supplied **only via environment variable** to use GitHub API rate limits; no token is printed.

A successful live report is:

```text
GAME_ROOM_STACK_AUDIT_VALID root=33 tip=116 drafts=81 links=80 openPRs=93 parentHeadsExact=true mainBaseExact=true
```

The report is deliberately **advisory**. If a parent is updated, a PR is retargeted, main advances or a PR is merged, the fixed pre-integration snapshot becomes invalid. Do not suppress the alarm; inspect the actual history, then update the integration baseline deliberately. The script does **not** prove git commit ancestry, conflict-free merging, runtime compatibility between individually merged steps, remote availability, or live deployment.

`--self-test` runs 13 offline fixtures including valid lineage, parent drift, missing/misnamed parent, main drift, draft/closed PR, duplicate heads/numbers, bad SHA, foreign branch and cycle checks. Both normal Windows package and release workflows already execute `server/check-browser-javascript.ps1`, which now requires syntax validation and the offline negative self-test. **Ordinary CI deliberately does not query GitHub metadata**: a temporary GitHub API outage or later legitimate integration must not silently block a reproducible package build.

## R15j — optional exact Git commit-ancestry preflight (2026-11-01)

The R15i `--live` mode only checks PR names, SHA equality and Draft status. **SHA equality in GitHub PR metadata is not proof that an individual child commit actually descends from its parent's commit.** The existing read-only auditor now also offers an explicitly operator-triggered `--live-ancestry` mode. It first performs the complete 81-stage metadata audit, then checks the **81 exact GitHub compare relations**: `main` base SHA → PR #33 head, followed by each parent PR head → child PR head through #116. For every pair it requires `status=ahead`, `behind_by=0`, `ahead_by>0`, and the compare merge-base SHA exactly equal to the expected parent SHA. Any mismatch or API failure blocks the result. Requests are limited to three in flight. After checking all 81 ancestry relations, the auditor re-reads the open PRs and `main` and blocks success if any audited ref or base SHA drifted during the run. This is not run by ordinary CI, and it never merges or edits branches.

```powershell
# Operator-only: populate GITHUB_TOKEN through an approved secret manager first.
if (-not $env:GITHUB_TOKEN) { throw "A read-only GitHub token is required" }
try { node server/audit-game-room-pr-stack.mjs --live-ancestry }
finally { Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue }
```

The token must be provided through an environment variable; it is never printed by the auditor. A successful audit emits `GAME_ROOM_STACK_ANCESTRY_VALID checks=81 root=33 tip=116 allParentsAncestors=true`, plus an explicit advisory that merge conflicts have **not** been checked. `--self-test` remains offline and now covers 21 metadata, ancestry-result and snapshot-drift cases; the existing normal Windows CI browser check invokes only this offline test. The 81-pair operator audit itself remains **unexecuted** until an authorized operator supplies a token; do not infer completion from offline CI.

Independently, GitHub's compare metadata was inspected on 2026-11-01: `main` commit `62ed59928558431e5608e9194f034e53685ef69a` is the merge base of the then-current PR #116 tip `57d5c8e40455077b2906cc24f98523e5ce490755`, with **879 ahead, 0 behind**. The immediately preceding #115 commit `639110fae27086071844be7b467019694137c043` was an ancestor of that tip (**5 ahead, 0 behind**). These **two** observed comparisons do not substitute for all 81 operator-mode comparisons, individual merge rehearsals, a security review, or live external HTTPS/WSS tests. Since this R15j update changes #116's head, all previous R15i exact-head CI results are historical and new Push + PR Windows CI must pass before marking this update accepted.

## Recommended controlled integration (requires explicit approval)

1. **Freeze additional feature PRs** temporarily, and record exact tip SHA plus approved scope. Preserve the current passing CI results and the existing README/documents. Complete an adversarial diff/security review of the cumulative PR #33→#116 changes against `main`; independently review authorization, room state machine, SQLite migration, WebSocket client lifetimes, packaging and release protections.
2. **Decide merge policy before touching any branch.** The current stack preserves original commits. Sequential GitHub **merge commits**, not squash, generally preserve parent commit ancestry when retargeting the next PR to main. Squashing an early PR changes commit ancestry and can cause downstream PRs to show earlier work again when retargeted; that requires careful rebases and revalidation. Never blindly merge all 81 PRs or delete a parent branch while its children still target that branch.
3. Starting with **PR #33**, confirm review approval, CI on the *actual proposed merge result*, branch protection/release permissions and mergeability. Only then make that single PR ready, merge it through the explicitly approved strategy, update the next PR's base to `main`, inspect its diff (only its own stage), rerun tests, and proceed **one PR at a time**. Keep an audit record of approved PR number, old and new SHAs, CI run, release notes, and rollback reference. If mergeability or the diff is unexpected, stop rather than force-push.
4. A release is a **separate, explicit decision** after repository integration, signed/provenance installer checks, migration/backup restore rehearsal, and actual LAN/WAN client acceptance. Do not interpret any localhost CI result as physical cross-network proof. Existing `docs/platform/GAME_ROOM_R14U_EXTERNAL_TWO_PLAYER_FIELD.md` already documents an operator-only, consent-gated HTTPS/WSS field test; reuse it on disposable rooms and approved hosts instead of reinventing a field probe. Its run mode changes game state.
5. Prior to release, verify independent Windows machines behind **different real network routes** (LAN and WAN), trusted HTTPS/WSS certificate/proxy configuration, bearer session revocation, reconnect latency (avg/p90/p99), actual 6-player/14-spectator workloads, and recovery after server restart. Only report those results after the tests actually occur.

## What changed in R15i

- **One read-only auditor:** `server/audit-game-room-pr-stack.mjs`
- **One deterministic CI gate:** adds `--check` plus `--self-test` to the existing JavaScript check, without external metadata calls.
- **This integration checklist.**

No changes to production server or browser runtime, user capacity, authentication, rate limits, versioned data, or release automation. The existing PR #116 remains Draft and is not merged or released. As this update advances PR #116's HEAD, its previous Windows CI results do **not** verify this new exact commit; rerun the required Push and PR Windows workflows before calling R15i validated.
