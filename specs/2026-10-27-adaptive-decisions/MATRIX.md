# Acceptance scenario matrix (E1.3)

Owner-approved basis: PRODUCT.md (scenarios), TECH.md §10 (unit groups). Outcomes are the E1.3 contract; unit groups map to TECH §10, others to stages E5–E7.

| # | Scenario | Expected outcome | Verified by |
|---|---|---|---|
| S01 | direct, no consultants | Resolution returned, zero consultant sessions launched, DecisionRecord `decided`, source `agent` | U-validator, U-guard |
| S02 | research for a real unknown | 1 researcher session, findings merged, route completes within limits | U-runner, E4 tests |
| S03 | material risk | Critique mandatory: unsound/blocker ⇒ escalate, never waived | U-validator, E4 tests |
| S04 | two independent unknowns | ≤2 parallel researcher sessions, both bound to same decisionId | U-parallel cap |
| S05 | unambiguous delegation, no allowlist | No extra permission prompt; `direct` allowed; authority basis recorded | U-validator |
| S06 | beyond original request | Route ⇒ `ask-human`; no autonomous action | U-validator |
| S07 | explicit user prohibition/preference | Honored over defaults; recorded in record | U-validator, E6 tests |
| S08 | no UI (headless), advisory | Recommendation prepared; dialog unavailable ⇒ falls back to today's no-dialog semantics | E6 tests |
| S09 | cancelled dialog (advisory) | Record `escalated`; blocker ladder unchanged; no auto-acceptance | E6 tests |
| S10 | stale/duplicate consultant result | Ignored idempotently; decision unchanged; no double charge | U-guard, U-accounting |
| S11 | focus/policy change mid-deliberation | Acceptance rejected (snapshot/generation mismatch); record `invalidated` | U-guard, U-fresh-read |
| S12 | restart mid-consultant | Record `invalidated`; no auto-restart of consultants | U-restart |
| S13 | malformed consultant payload | Rejected as schema failure ⇒ route escalates at round limit | U-runner |
| S14 | unavailable model (critique mandatory) | ⇒ `ask-human`; degraded same-model critique never used | U-runner, U-validator |
| S15 | consultation/spend limits | Rounds/parallel/deadline capped; budget-gated refusal ⇒ `ask-human` with budget line | U-limits, U-accounting |
| S16 | oracle dedup conflict | Decision fingerprints distinct; shared `maxConsultationsPerGoal` bounds alternation; oracle path unchanged | U-cap, U-fingerprint |
| S17 | old settings/goals | Load unchanged; no `decisionMode` ⇒ `manual` behavior | U-policy |
| S18 | project enable, multiple goals | Mode applies to all active goals of the project only | U-isolation |
| S19 | project isolation | Two projects, different modes, independent acceptance | U-isolation |
| S20 | disable from another session | Fresh mode read at acceptance ⇒ autonomous acceptance stops; already-accepted stay | U-fresh-read |
| S21 | existing confirmations & task-tree autonomy | draft/proposal/tweak and autonomous task restructuring byte-identical; no false invalidation from task changes | U-noop, U-task-invariance |
| S22 | prompt injection in read files | Planted instructions do not alter consultant schema output or route | U-injection fixture |

## E7.1 acceptance evidence

Evidence: `tests/goal-decision-acceptance.test.ts` (31 cases; every scenario has at least one case titled `S<nn> ...`). Entry points: the real `piGoalExtension` lifecycle (`session_start`, the registered `goal_decision` tool, the restart hook) and `executeDecisionTool` with the real `runConsultant`, router, record store, runtime guard, and accounting. Only the SDK session factory is scripted through the existing `createSession` seam. "Depth evidence" names the unit suites that already cover the mechanism more finely.

| # | Result | Acceptance cases | Depth evidence | Gap |
| --- | --- | --- | --- | --- |
| S01 | pass | S01 (session, registered tool) | U-validator, U-guard | — |
| S02 | pass | S02 | U-runner | — |
| S03 | pass | S03 (route floor; blocker not waived) | U-validator, E4 tests | G4 (materiality is the proposer's classification) |
| S04 | pass | S04 ×2 (two unknowns; three unknowns: live peak 2) | U-parallel cap | — |
| S05 | pass | S05 (session, no UI, authority basis recorded) | U-validator | — |
| S06 | pass | S06 (session, `selfRoute` ask-human) | U-validator | G4 |
| S07 | partial | S07 (session, forbidden category overrides the agent's pick) | U-validator, E6 tests | G3 |
| S08 | pass | S08 ×2 (headless session; prefilled recommendation) | E6 tests | — |
| S09 | pass | S09 (cancelled dialog) | E6 tests | — |
| S10 | partial | S10 (guard + accounting, duplicate and stale) | U-guard, U-accounting | G2 |
| S11 | pass | S11 ×3 (mode switch, objective change, focus change) | U-guard, U-fresh-read | fixed defect G1 |
| S12 | pass | S12 (real `session_start` restart) | U-restart | — |
| S13 | pass | S13 ×2 (malformed researcher; malformed critic) | U-runner | G5 |
| S14 | pass | S14 ×2 (no critic configured; critic equals author) | U-runner, U-validator | — |
| S15 | pass | S15 ×3 (rounds; deadline; budget line) | U-limits, U-accounting | — |
| S16 | pass | S16 (fingerprints distinct; shared cap with oracle) | U-cap, U-fingerprint | G8 |
| S17 | pass | S17 (no `decisionMode`, session) | U-policy | — |
| S18 | pass | S18 (one project, two goals in sequence, paused refused) | U-isolation | G9 |
| S19 | pass | S19 (two projects, manual vs bounded-auto) | U-isolation | — |
| S20 | pass | S20 (switch from another session mid-critic; earlier decision stays) | U-fresh-read | — |
| S21 | partial | S21 (task-tree change mid-critic does not invalidate) | U-noop, U-task-invariance | G6 |
| S22 | pass | S22 ×2 (planted output and file; planted settings) | U-injection fixture | G7 |

Gaps and limits (documented, not widened in E7):

- **G1 (defect, fixed in E7.1).** The tool path passed the goal snapshot taken at call start to the acceptance guard, so an objective, focus, or scheduler-generation change during a consultant run was accepted (TECH §6 binding not enforced). `settle()` in `goal-decision.ts` now reads the goal live; `acceptDecisionResolution` treats no focused goal as `goal-not-active`. The S11 objective and focus cases failed before the fix and pass after it.
- **G2.** The per-result guard `acceptConsultantResult` and the `activeDecisionId` check are not on the production tool path: `GoalRecord.activeDecisionId` is never set and the decision view does not carry it (E6.1 known gap). Consultants are awaited inside the tool call, so duplicate or out-of-order deliveries cannot reach the tool today. S10 is verified at the guard and accounting level, not through the tool.
- **G3.** "Explicit user preference honored over defaults" is semantic. Only the mechanical floor (forbidden categories, scanned over question, options, facts, unknowns) and recording of the authority basis are tested.
- **G4.** "Beyond the original request" (S06) and materiality (S03) are classified by the proposing model (`selfRoute`, `materialRisk`). No mechanical check exists; the conservative default (absent `materialRisk` = material) is what is tested.
- **G5.** S13 says "escalates at round limit". The implementation escalates at the failing phase: a malformed or failed consultant is an immediate escalation (TECH §5: a failed research phase escalates at once), so no second round is attempted. The outcome (ask-human, no critic after failed research) matches; the timing differs from the matrix wording.
- **G6.** S21's byte-identical draft, proposal, and tweak confirmations are not re-compared by a new test. They rely on the existing drafting and manual byte-identity suites in `npm test`, which still pass.
- **G7.** S22 simulates a model that echoes planted text by scripting the consultant session. No real model is run, so only the code-side invariants (schema-only record fields, router-computed route, blocker never waived, mode from the project file only) are evidenced.
- **G8.** The S16 oracle cap is shown through `runCountedOracle`; the oracle's own per-fingerprint limit stays covered by the existing oracle suite, not re-tested here.
- **G9.** S18 "multiple goals" is one project with goals in sequence. Concurrent multi-goal focus is a non-goal (PRODUCT).
- **G10.** The scripted `createSession` seam is the only fake. The production SDK session factory is not launched by any acceptance case: consulted routes through the registered tool use the real factory only in production.
- **G11.** No user-facing `docs/` page for `decisionMode` was written; no E7 criterion requires one. The CHANGELOG entry is the only release note.
