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
