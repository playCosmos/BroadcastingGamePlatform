# R14d — GameRoom integration readiness and release gates

**Parent:** R14c Draft PR #85, verified head `3a0801358033a02a9e42039ab367c28e076a22b8`. This R14d work must remain a **stacked Draft**, not a merge or release.

## 1. Verified repository inventory (2026-10-29 KST)

- `main` at `62ed59928558431e5608e9194f034e53685ef69a`; the R14c integration head was **657 commits ahead / 0 behind main**. This is the cumulative history of Yacht/GameRoom work, not an R14c-only diff; merging the entire chain carries significant API, Java, web, and migration changes.
- **62 open PRs** (#24–#85) exist across independent Map Maker, TTS, Yacht and GameRoom development. They are **not** one merge chain.
- Canonical Yacht + GameRoom lineage is **50 staged PRs**: #33–#35, #37–#40, #42–#58 and #60–#85. Each next PR's target is the preceding canonical feature branch; this lineage reaches R14c #85.
- **Do not batch-merge by numeric PR number.** #41 (`feature/common-game-room-r5-drawing-guess`) is an alternate R5 branch sibling of #42; its history diverges from canonical R5. #59 (`feature/common-game-room-r13d-host-presentation`) is an alternate R13d sibling of canonical #60. These alternatives do not belong in the canonical chain. Their unique changes require separate functional review before closing or selectively porting anything.
- #36 (`docs/common-game-room-architecture-plan`) is a separate plan PR based on main, not an ancestor of #37 or #85. Compare it separately to the latest architecture documents; do not merge blindly.
- Other open PRs (#24–#32) are independent Map Maker/adversarial-review/TTS tracks. Their overlap with Yacht/GameRoom cannot be inferred from the number sequence.
- GitHub currently reports the inspected recent canonical PRs **mergeable against their configured immediate base**. That is **not** a guarantee of conflict-free merge of every PR directly into main or a guarantee of successful runtime integration.

## 2. Integration order (no merge action authorized)

1. Select a release candidate integration target and freeze independent changes. Compare its exact head to current main. Re-run the full suite after any base branch or target changes.
2. Review #36 design differences and the alternate #41/#59 changes before deciding whether either contains a missing requirement. Do not merge both siblings just because both PRs exist.
3. Merge/rebase only the **canonical lineage** in dependency order (#33–#35 → #37–#40 → #42–#58 → #60–#85 → R14d). After each upstream merge, update downstream PR base/refs as needed; GitHub squash merging changes commit ancestry and can make stacked PR diffs appear huge. Do not assume a stacked PR remains clean without refreshing its base.
4. When the final integration state is on the intended base, run complete Windows CI, real Chrome/Edge E2E, regression probes, migration/upgrade tests and packaged startup validation at **that exact commit**, then review release notes and operational gates.
5. The current stack remains Draft; merge, publish, and release require explicit release authorization and separate final acceptance.

## 3. CI drift and deployment safety found

- Previous Windows workflow enumerated dozens of feature branch names. Every additional R-stage needed hand-edited push and PR base filters. R14d uses anchored globs `feature/yacht-y*`, `feature/common-game-room-*` plus `main`, and includes release.yml changes in PR path filtering. New stacked R/Y branches inherit CI without further workflow rewrites.
- Before R14d, the manually dispatched `release.yml` ran server/PowerShell/JS probes but **omitted the real GameRoom Chrome/Edge E2E** required on normal staged CI. R14d inserts browser acceptance **after regression probes and before Windows packaging/publishing**.
- Prior release workflow could be manually dispatched on any ref. R14d restricts publication to `refs/heads/main` or a deliberate `refs/heads/release/*` branch, preserving historical explicit release branches while rejecting unmerged feature branches. This is a guard against accidental publish, not authorization to release now.
- `server/check-integration-workflows.ps1` runs as a Windows CI step to statically enforce branch patterns, source-ref guard and test-before-publish ordering. It does not call GitHub Release APIs.
- README previously described Yacht as only Y0/Y2 and unplayable although the current integration branch has Yacht R4 standalone Multiplayer Beta. The README now states the staged Beta accurately and distinguishes unmerged features from `main`.

## 4. Go/no-go checklist

| Gate | Assessment |
|---|---|
| Latest R14c push and PR CI on exact head | **PASS**: 507 Drawing, 95 Yacht static, 555 Chrome/Edge E2E; Windows x64 package |
| No new server/client authorization regression in automated lifecycle | **PASS in scoped CI**: anonymous host/member/spectator, chat, reconnect, revoke, rejoin, leave, close |
| Branch ancestry / alternate-implementation conflict resolution | **OPEN**: #41, #59 and separate plan #36 are not automatically part of integration |
| Integration into main | **NOT DONE**: Draft chain still open; the current base remains main's earlier snapshot |
| Database upgrade and rollback on persistent production data | **OPEN**: V29–V44 should be smoke tested on backups (fresh fixture alone is insufficient) |
| Hosted production proxy, HTTPS/WSS, real SOOP provider, high-spectator room load | **OPEN**: field/deployment tests required |
| Clean Windows machine install/start/stop, signature/SmartScreen, release notes/version | **OPEN**: package CI checks the app image but not full distribution operations |
| Release source & E2E prepublish gate | **IMPLEMENTED in R14d**; verify on exact R14d CI before considering green |

## 5. Explicitly excluded

No automated merges, branch rebases, historical PR closure, release creation, schema rewrite, new runtime dependency, forced account/host approval, or replacement of developer/manual field acceptance. A green R14d CI is **integration readiness for further review**, not a production release sign-off.