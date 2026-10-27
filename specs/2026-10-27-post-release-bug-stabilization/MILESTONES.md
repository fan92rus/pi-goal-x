# Implementation log

## 2026-10-27 — planning audit

- Started from main `fe0e38f` (package 0.34.0). Versions 0.33.0 and 0.34.0 were both released on 2026-10-24 and form the relevant large-change baseline.
- Read every open issue (#108, #110, #113, #114 and #115), every open PR (#96, #109, #111, #112, #116 and #117), their comments/reviews, and the complete patches for the four bug-fix PRs.
- Found no issue comments, no substantive PR reviews and no reported CI checks on the open PR heads.
- Initially classified #108 as follow-up design work and #96/#112 as feature work. The later cache-quality steering below supersedes #108's deferral: measurement and non-regression are now in scope, while an unproven retention redesign remains conditional.
- Preserved the pre-existing untracked `specs/2026-10-01-open-pr-disposition/` directory unchanged.

## Baseline and branch validation

- Main typecheck and lint pass on local Node 26.10.0/npm 11.19.1.
- `scripts/ci-checks.mjs` passes: 1,216 tests in 91 files with zero failures/skips, ten Pi 1.4 controls walkthroughs, and a live three-request draft/execution/audit lifecycle that archives successfully.
- Sequential context gate and provider cross-check pass. Retention measurement completes for text, tool-output and image histories at 64 KiB, 1 MiB and 4 MiB.
- In isolated temporary worktrees:
  - PR #109 passes typecheck plus 10 audit-interruption checks.
  - PR #111 passes typecheck plus 56 task checks.
  - PR #116 passes typecheck plus 89 widget checks.
  - PR #117 passes typecheck plus 99 core/scheduler/objective checks.
- These focused passes do not change the PR dispositions. The missing cross-boundary, race, host, provider and cache cases are material.

## Failed attempt that exposed a harness bug

- Ran typecheck, lint, context gate, provider cross-check and retention measurement in parallel.
- Typecheck, lint and retention passed, while the context gate reported stale-checkpoint baseline drift and the provider cross-check saw only two of five expected goal tools.
- Both context commands passed when rerun sequentially, with byte-identical baseline data and six real SDK payload captures.
- Root cause: both commands mutate and recursively delete the hard-coded `/tmp/goal-context-capture`. Their processes can replace each other's fixture between capture and assertion.
- The technical plan now makes per-invocation workspace isolation and a concurrent regression the first implementation milestone.

## Bug-design findings

- PR #109's shutdown settlement uses the currently focused goal, does not reliably abort the controller or stop the animation, and lacks an exactly-once guard. Its lifecycle reader notices a newer start, but existing status/history readers prefer an older result and hide that state. Integrate the behavior with #113 through a fresh lifecycle design.
- PR #117's pure normalization direction is useful, but structural rejection remains `isError: false`, provider-boundary coverage omits `update_goal`, and classification must precede transaction flush to prove no side effects.
- PR #116 addresses default Escape for only three actions, while all Goal shortcuts run before the focused component. `hasOverlay()` also includes non-capturing overlays. Actual focus ownership must guard the whole listener.
- PR #111's count formula is sound in isolation. Registered completion, auditor, prompt, nested-tree and count-invariant coverage is still required.

## 2026-10-27 — cache and PR-quality plan revision

The user made two release constraints explicit:

1. maximize safe cache reuse and avoid changes that needlessly invalidate retained prefixes;
2. include PR code only when it is exceptionally well written and independently tested, otherwise implement the behavior afresh.

Following the repository steering order, `PRODUCT.md` was updated first, then `TECH.md`, then this log. No runtime, test, README or changelog file was changed during this revision.

### Cache audit

- `goal-live-retention.ts` already preserves exact request-only tails using session/anchor/base-history fingerprints. Identical retries add no blocks.
- Retention intentionally resets for policy/state changes, history rewrites, unsafe tool-result insertion, empty-to-nonempty history changes and bounded rollover.
- Current safeguards cap retained live tails at 32, tracked sessions at 16 and counter bytes at 4,096.
- `goal-prompt-cache.ts` relocates a pre-existing explicit marker from a transient live tail to real history. It does not enable caching, change TTL/tier, add a marker, place one on thinking, or split a tool-call/result pair.
- Unit and SDK coverage already exercises literal prefixes, unchanged retries, reset cases, per-session isolation, bounded growth, delayed results, large payloads, Anthropic/Bedrock marker behavior, OpenAI shapes and compaction.
- The missing release evidence is a single deterministic 0.34.0-versus-candidate artifact that reports immutable hashes, exact longest reusable prefix, block/byte/token estimates, marker metadata and a reason for every break.
- Issue #108 reports deterministic prefix breaks in state-changing sequences and variable live cache-read measurements. Its experimental append-only approach appears promising but has not proved safe supersession for cleared, cancelled or instruction-bearing state.

### Important correction to the original lifecycle plan

The first draft said teardown should clear all live-tail retention owned by the extension instance. That is too broad.

A delayed old-session cleanup could run after a replacement session with the same external identifier has retained a useful prefix. An extension-wide or key-only clear would then destroy the new entry and reduce cache hits. The revised plan:

- gives each outgoing session immutable retention leases with an ownership generation;
- conditionally releases only exact leases still owned by that generation;
- makes late cleanup a no-op after a newer generation acquires the identity;
- avoids broad clear when ownership is uncertain and relies on bounded eviction instead.

This correction is now a release-blocking lifecycle and cache invariant.

### Cache plan decisions

- Cache comparison is added before product implementation and rerun after every behavior track.
- All four fixes must preserve byte-identical host/system/tool/schema prefixes. None requires a public schema change.
- #113/#109 may alter only session/audit live state and must not clear or mutate the replacement session's cache.
- #115/#117 keeps the public `update_goal` schema hash unchanged; normalization remains a runtime-only pre-flush boundary.
- #110/#111 changes only the incorrect skipped-task scenario state, without an extra retention reset.
- #114/#116 is required to produce zero provider-payload or cache delta.
- #108 is reclassified as:
  - mandatory deterministic measurement and no-regression protection for 0.34.1;
  - optional, isolated fact-only retention optimization if adversarial semantic tests and a strict reuse gate both pass;
  - separate follow-up if either safety or measurable improvement remains uncertain.
- Deterministic serialized-prefix evidence is authoritative. Paired live cache-read trials remain supporting evidence because provider routing, TTL and cache thresholds are variable.

### PR acceptance decisions

- PR heads will not be merged or cherry-picked merely because their focused suites pass.
- Each issue is reproduced independently and receives a behavior-first red test before contributor code is evaluated.
- Every contributor hunk is recorded as keep, rewrite or reject with rationale, independent test evidence and cache impact.
- #109 requires a substantial rewrite.
- #111's small formula can be retained only if the complete walker and registered-flow contract passes; otherwise it is rewritten.
- #116's ownership boundary is reimplemented broadly, with only independently useful fixtures considered for reuse.
- #117's pure-planner idea may be adapted, but schema, error and before-flush behavior require independent implementation evidence.
- #96 and #112 contribute no hunks to this bug-fix campaign.
- Credit remains accurate for useful diagnosis, design and tests even when implementation is rewritten. Co-author trailers are reserved for material authored code actually retained.

## 2026-10-27 — full inventory and implementation-plan recheck

Updated `PRODUCT.md` first, then `TECH.md`, then this log in response to the renewed request to consider all open issues/PRs, defer features, maximize safe cache reuse and accept only thoroughly reviewed code. The earlier audit and test results above are preserved as historical evidence; they were not rerun or newly claimed by this revision.

### Fresh evidence

- GitHub's open-issues collection returned five issues (#108, #110, #113, #114, #115) and six PRs (#96, #109, #111, #112, #116, #117); the separate PR collection agreed. Read all bodies, all changed-file patches including both feature PRs, review submissions and inline comments. All collections fit on their requested 100-entry pages.
- All six pinned PR heads have zero check runs and zero commit statuses. Discussion counts and inline comments are zero. #112's one review submission says its bot reviewer had insufficient quota; it supplies no review evidence. The repository does configure PR CI, so missing runs are an intake problem to investigate, not an exemption.
- Recorded every reviewed head and source link in TECH §1.4. #96 is conflicting according to GitHub and remains deferred along with #112. No PR was merged, changed, approved or commented on.
- Verified remote/local main as `fe0e38f8cd03bfacc9baca730e9a902d3cff116e`. The v0.34.0 annotated tag resolves to `8f0c28b08a152efef9da2728e7f8e96b02455506`. `git diff --stat v0.34.0..HEAD` contains only ranking/spec/validation records, establishing runtime/dependency/test equivalence rather than conflating main with the release tag.
- Read the 0.33.0/0.34.0 release notes and current context, retention, cache-marker, lifecycle, task, tool-input, persistence, TUI API and CI code. The plan now preserves those releases' behavior through an explicit cross-feature matrix.

### Independent baseline probes executed in this revision

Ran a no-network `node --experimental-strip-types --input-type=module` probe importing the current real modules and Pi validator. All assertions confirmed the expected current defects/boundaries:

| Probe | Observed baseline result |
| --- | --- |
| Complete + skipped task list | `pending: 1`, `pendingTasks.length: 0`, and a false `blockCompletion` warning. |
| Exact #115 JSON, including `completion_summary: "…"` | Accepted by Pi 1.4 `validateToolArguments`; rejected by the registered `update_goal` executor, with no `isError` flag. |
| Flush ordering on that rejected call | An instrumented `flushGoalTransaction` hook was called once before rejection. This proves ordering, not the later dirty-buffer regression, which remains to be implemented. |
| Retention across appended conversation | Unchanged policy retains the preceding message prefix; a changed state block breaks it as currently designed. |

These are baseline observations, not passing-after bug-fix tests. No production or test implementation, full-suite rerun, paid provider trial or package publication occurred in this revision. The issue author's exact 4/10 prefix-break sequence and live cache percentages remain attributed reports; they have not been independently reproduced here.

### Corrections and strengthened decisions

- Plain storage snapshots are insufficient on their own: `GoalService.appendEvents` can append to the currently active turn buffer, and `flushTurn` uses its supplied storage context. The plan now requires original transaction/root ownership as well as session ownership, with dirty-buffer and project-switch regressions.
- Session generation must be invalidated before an awaited load. The current load increments focus revision after disk reads; late loads, progress callbacks, timers and `finally` blocks require guards before touching replacement state.
- Audit state must survive the Escape decision period after the controller is cleared. The plan distinguishes running/awaiting-choice/settling/settled, fences all callbacks, requires real pending-auditor tests and separates in-memory settlement from a durable ledger result.
- Overlapping audits of one persisted goal are an explicit race investigation. An in-memory token alone cannot be assumed to correlate cross-process ledger events. Resolve a demonstrated ambiguity through existing ownership/revision rules or a documented backward-compatible design before accepting the fix.
- The keyboard design now recognizes that Pi 1.4's `isOverlayFocused` is protected and that text accessors do not uniquely identify the main editor. A real TUI fixture must establish the usable ownership seam; native dialogs, foreign editors, non-capturing overlays and every configured action are covered.
- Cache comparison now uses ordered serialized model input plus system/tools/options, not whole JSON-envelope prefix matching. Raw-order hashes remain authoritative over normalized schema digests. Deterministic payload reuse is cache eligibility, not measured provider cache hits.
- Expanded the reset taxonomy to cover every existing retention branch, including absent observations, removed goal context, empty-history reanchoring, unsafe result anchors, identity loss and capacity/session eviction. Allowed labels cannot excuse extra reset counts.
- Required negative controls for the cache comparator and targeted broken-code variants for new bug tests. Added total/cumulative request overhead and at least two rollovers to optimization acceptance so growing context cannot masquerade as improved efficiency.
- Added a required #108 measured disposition, predeclared paired-trial method, cost/usage interpretation and a clean drop path for an inconclusive optimization. Stable schemas, prompt prefixes, cache identities and disabled-cache behavior remain protected.
- Added combined release regressions for provider filler + skipped tasks + audit, stale checkpoints, retries, strict/default scheduling, remapped controls/pause order, compaction and storage failures. Future fixes must extend the same contract matrix.
- Consolidated the full-suite command under the existing CI runner to avoid duplicate runs, added focused native Windows persistence evidence, and required installed-package tests to prove they load the tarball rather than the source checkout.

### Plan status and next work

The complete plan is ready for review; implementation remains unstarted. The existing spec-index entry remains `ready_for_review`, and the older untracked open-PR-disposition directory is preserved.

Validation of this revision: refreshed the open inventory once more and confirmed all issue update timestamps and all six PR heads were unchanged. Plan structure, all issue/PR source links, milestone A–G coverage, spec registration, edited-line whitespace and release/main runtime equivalence checks passed. Required future tests/commands are explicitly distinguished from completed baseline probes. No runtime, README, changelog or dependency file was edited.

When implementation starts:

1. Capture independent failing bug regressions and isolate the context harness with forced-overlap tests.
2. Freeze a 0.34.0 cache report and verify that its comparator rejects known bad captures.
3. Implement session/audit ownership and `update_goal` normalization, then complete the skipped-task and all-shortcut focus tracks; review each retained contributor hunk and run its cache/boundary gates.
4. Run the combined scenario matrix and investigate #108 with an explicit optimization keep/drop decision.
5. Validate the exact integrated candidate, then its installed package, with traceable source/artifact evidence before any release or issue/PR disposition is executed.

## 2026-10-27 — include context display with default off; require simpler code

The user explicitly brought `showContextUsage` into this stabilization campaign and clarified the desired default from on to **off** while planning was in progress. The current contract is `showContextUsage: false` by default; explicit `true` restores the existing line. This supersedes #112's deferral in all earlier entries above, its contributor default-on proposal and the initial default-on preference. Other feature work, including #96, remains deferred.

Updated `PRODUCT.md` first for each behavior change, then `TECH.md`, then this log. TECH now has Milestone F for context display, G for the conditional #108 optimization and H for integrated release validation. This remains a planning revision; no setting or runtime fix has been implemented.

### Evidence and decisions

- Reread #112's body and all eight changed-file patches through GitHub. Its head is still `1343fbaf6a600c294b23cf72b852a2885bd0bf96`. Its small use of existing settings and prompt-counter paths is suitable for independent review/adaptation, but the head is not accepted unchanged.
- The proposal's resolver and omitted-settings renderer both default on and need changing. It omits `effectiveSettingsReport`, lacks full global/project, persistence/reset and actual menu coverage, and tests “accounting unaffected” only by calling a formatter. The advanced-usage insertion also breaks the placement of the run-allowance explanation. The plan specifies the missing boundaries and excludes the README hunk.
- Required runtime scope is one boolean through existing settings/provenance/persistence/reporting/menu code and one condition in `goalPromptParts`. Reuse current mutation/refresh hooks. No new timer, listener, dependency, environment variable, cache, schema, scheduler heuristic or generic visibility framework is justified.
- Default/explicit false omits the fresh context line, including unavailable occupancy; explicit true reproduces the old counters. Preserve lifetime usage, run information, policy, accounting, budget enforcement, continuation and compaction.
- Toggling affects future snapshots. Existing retained observations remain historical under the current latest-snapshot wording; the setting is not retroactive redaction. A toggle must not purge retention, change policy memoization or rotate cache identity. The release comparison records the intentional default counter difference without normalizing it away or claiming cross-version identity beyond the changed line.
- Every fix must simplify its touched production path and remove the implementation it supersedes. The hunk ledger and final release review must identify consolidation/removal and justify added runtime mechanisms. Keep cleanup local, reuse existing test/capture infrastructure and remove temporary experimental modes. Meaningful tests may increase line count; smaller production complexity is the acceptance criterion.

### No-network baseline probe

Ran `node --experimental-strip-types --input-type=module` against the current real modules, with assertions for:

- current parser treats `showContextUsage` as unknown, and the current helper ignores explicit false;
- a synthetic fresh-counter fixture with only the context line omitted preserves the preceding message prefix in `LiveTailRetention`, appends exactly one counter snapshot and adds nothing on identical retry;
- the previously sent context line remains in a historical retained snapshot, while the latest snapshot omits it;
- starting with the hidden fixture injects no context line from this path.

All assertions passed. The omission was constructed in the probe as a fixture; it is not an implemented setting, a passing-after regression, registered-provider validation or measured cache-hit evidence. Full runtime suites and paid provider trials were not rerun for these document edits.

### Status

Implementation remains unstarted and the spec remains ready for review. The existing spec-index entry and historical open-PR-disposition directory are unchanged. Plan validation passed: default-off requirements and renderer contract agree; milestones A–H and all five issue/six PR links are present; #112 is included in every current disposition table; spec registration is unique; Markdown fences, conflict-marker and edited-line whitespace checks pass. No runtime, test, README, changelog or dependency file was changed. Future implementation must execute the settings, accounting, compaction, cache and installed-package gates now specified.

## Implementation — A: isolated captures and comparative cache gate

- Started `codex/post-release-stabilization` from `fe0e38f`; refreshed all open issues/PRs, with the same five issues and six PRs. No contributor head was merged.
- Replaced the shared capture root with invocation-owned temporary directories. Provider cross-checks inspect the live fixture before its owner cleans up; concurrent captures never mutate environment overrides.
- Added forced-overlap/failure cleanup regressions, exact-payload comparator negative controls and a pinned-release comparison using the same driver and SDK on both source trees. Reports are generated as CI artifacts, avoiding a large checked-in payload snapshot.
- Passed context gate (24 fixtures), provider cross-check (six actual SDK captures plus Responses compatibility), TypeScript, ESLint, four new harness/comparator checks and the cache gate (384 adapter scenarios; 1,000 retention transitions, 32 bounded rollovers). No network provider dispatch occurs.
- The first archive run could not identify its Git SHA because an extracted archive has no `.git`; fixed metadata handling and reran successfully. The gate assigns the verified pinned release SHA to the archived report.
- Runtime behavior and all contributor code remain untouched at this milestone. The capture/report modules reuse existing fixtures and adapters; no production cache abstraction was added.

## Implementation — B: session ownership and completion audit settlement

- Independently reproduced stale start/tree/shutdown cleanup failures, a real pending audit not aborted on shutdown, an unhandled auditor exception/timer, an older verdict masking a newer start, and two registered sessions attributing an older rejection to a newer audit.
- Updated PRODUCT then TECH for the demonstrated cross-session audit-ID requirement. New audit events carry an optional internal UUID; legacy ledger/checkpoints remain readable. Latest-attempt derivation and checkpoint reconstruction share matching rules and avoid repeated full-ledger scans.
- Replaced bare audit controller/abort flags and duplicated completion/skip branches with one attempt record and idempotent settlement. Original storage is captured before awaits, outcomes append durably outside unrelated turn buffers, and failed persistence is visible. Revision checks prevent approval from overwriting changed requirements; completion preserves current usage.
- Unified start/tree/shutdown cleanup, detached terminal handles before invoking them, invalidated pending operations before async loads, and fenced late progress, timers, modal answers and cache releases. Buffered turns pin their original storage; failed outgoing writes emit diagnostics before detachment.
- PR #109 runtime hunks were rewritten, rather than merged. Its reported behavior is credited; the new tests use genuinely pending audits and actual registered handlers.
- Passed focused lifecycle/transaction/session-safety regressions, 73 completion/settings/ledger/status/compaction checks, installed Pi session-safety workers (including stale reload and delegated sessions), TypeScript/ESLint and the 384-scenario release cache comparison with no payload delta.
- Added default/external-root project-switch tests, same-external-ID late callbacks/cache eviction, Escape-dialog replacement, changed-task approval rejection and real EISDIR ledger failure. Corrected the external-root fixture to include the required stored focus root; the production focus-isolation rule was preserved.
- Native Windows validation remains a release gate; local results are macOS/Pi 1.4 evidence, not a Windows claim.

## Implementation — C: classify update_goal before flushing

- Both independent registered regressions failed before the fix: the verbatim #115 object never reached the auditor, and structural conflicts returned no error flag (with the pre-validation flush still present).
- Added one pure typed planner in the existing tool-input module. It recognizes exact payload-free ready filler beside status, removes only blank optional input, names real field conflicts and preserves input objects. The executor now dispatches that plan after validation and before its existing flush; public schemas/descriptions/order are unchanged.
- Reimplemented #117's behavior from the contract. No contributor head or source-text assertion was adopted. Meaningful wait/lifecycle conflicts and malformed/payload-bearing ready objects remain errors.
- Passed action/planner matrices, dirty-buffer repair, strict/default actual scheduler assertions, real SDK argument validation, the existing tool-input worker and a new local Responses server. The latter sends the exact recorded arguments through Pi's installed tool path, runs the real nested independent auditor and archives in exactly two provider requests.
- Extended Responses schema capture to include update_goal in all three strict-compatibility modes. TypeScript, ESLint, provider cross-check and the 384-scenario cache comparison pass with zero payload/schema delta.

## Implementation — D: skipped tasks are terminal

- The independent flat-reference invariant and registered completion tests failed on the old counter: complete+skipped trees reported pending work and produced false task gates.
- Corrected the existing shared walker with `total - rawComplete - rawSkipped`; no second counting path or task-status change was introduced. This is the minimal correction identified in #110/#111, independently verified and credited.
- Added fixed-seed generated nested trees across both display and pending-collection modes, immutability and count-additivity checks, and real completion/auditor/prompt/deferred-archive positives and negatives. A pending child under a skipped parent still blocks; auditor rejection still blocks completion.
- Extended the local Responses regression to combine the exact filler object with complete+skipped blocking tasks and the real nested auditor. All 80 focused task/auditor/SDK checks and TypeScript pass; the cache gate still reports no unrelated payload delta.
