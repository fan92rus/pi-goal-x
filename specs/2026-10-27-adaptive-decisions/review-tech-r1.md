# Adversarial review r1 — TECH.md (adaptive decisions)

Reviewer: read-only adversarial review against PRODUCT.md (owner-approved) and plan E2–E6, anchors verified against 0.34.0 code.
Verdict: **blocked** — 1 blocker, 3 major, 5 minor. Core architecture is sound and anchored, but §2's settings-pickup mechanism verifiably fails a PRODUCT hard requirement, and two plan-mandated behaviors (E5.3 budget gating, §7 shared cap) are silently narrowed.

## Anchor verification (task items 2, 5)

Verified real in 0.34.0:
- `runBlockerOracle` (extensions/goal-oracle.ts:212), `OracleAdvice` (:132), `resolveOracleModel` (:191), `BlockerFingerprintInput` (:53); "one successful consultation per blocker fingerprint" (file header, :11).
- `ResolvedGoalOracleSettings` (extensions/goal-settings.ts:175), `invalidateGoalSettingsCache` (:306), `invalidateSettingsCachePath` (:311).
- `goal_question`/`goal_questionnaire` in extensions/goal-drafting.ts via `runGoalQuestionnaire` (import :14, call with `recommended` :257) — advisory-prefill claim is implementable as written.
- `runGoalBlockedFlow` (extensions/goal-core-tools.ts:248); lifecycle prompt exists at exactly ~:122 (goal-core-tools.ts:122) — TECH's "~:122" is accurate.
- `applicableGoalTools` (extensions/goal-tool-names.ts:72, consumed in goal-state.ts:325) — visibility pattern reusable as claimed.
- `GoalAccounting` class exists (extensions/goal-accounting.ts:24) with interval-based `charge()` (:54); `chargeKeyed` does not exist and TECH correctly marks it "new" — extension point honestly flagged.
- `GoalRecord` (extensions/goal-record.ts:35) has no `activeDecisionId` — TECH's "gains only" is accurate.
- Scheduler state has `wait`/`decision.kind:"wait"` phases (extensions/goal-scheduler-state.ts:20–22) — "scheduler wait/signal not involved in v1" is coherent.
- Sidecar storage pattern feasible: `renameAtomic`/`atomicWriteGoalFile` (extensions/storage/goal-files.ts:4, :274), revision-conflict detection (:53).
- Session factory `subscribe?` exists (goal-oracle.ts:290) and is exercised in production code (goal-auditor.ts:352 `session.subscribe((event) => ...)`) — usage-capture claim is anchored, not fictional.

"Скопирован, не импортирован" for the runner: **reasonable**. Plan E4.1 says "выделить или адаптировать минимальный runner… не переписывать весь oracle"; `runBlockerOracle` is self-contained (injected `createSession`, per-call tool list, custom submit tool), so a copy keeps `goal-oracle.ts` byte-stable (PRODUCT "manual is byte-for-byte today") at the cost of ~100 duplicated lines. Defensible; not a defect.

## Findings

### F1 — BLOCKER: cross-session mode change cannot be picked up; TECH's mechanism is insufficient (§2 vs PRODUCT, plan E2.1/E6.3)
PRODUCT (approved): "A mode change is picked up by all sessions of the project **before a result is accepted**"; acceptance scenario "disabling from another session"; plan E6.3: "Переключение проекта в manual во время разбора прекращает автоматическое принятие… **после сверки настройки**"; plan E2.1 requires tests for "применение изменения настройки разными сессиями".
TECH §2 claims: "Cache invalidation reuses the existing settings-cache invalidate hook; the runtime re-resolves settings before accepting any consultant result".
Evidence: the existing hook is **in-process only**. extensions/goal-settings.ts:295–311 — `settingsFileCache` is a plain `Map`, "Session boundary (session_start / resume): drop the zero-op settings cache"; `invalidateSettingsCachePath` fires only from same-process writes (goal-settings.ts:1217, :1243). There is no stat/mtime/watch on cached reads (grep for `stat|mtime|watch` in goal-settings.ts: no hits in the read path; comments say "zero-op steady state", "served without any stat").
Repro: session A resolves decision settings (cache warm) → starts `bounded-auto` deliberation; session B writes `decisionMode: "manual"` via `mutateSettingsLayer` (invalidates B's cache only); A's acceptance guard "re-resolves" — served from A's stale cache — still sees `bounded-auto` and accepts autonomously. PRODUCT requirement fails as specified.
Required in TECH (not prescribed here): define the freshness mechanism explicitly (e.g., read the mode/settings snapshot fresh from disk at acceptance time, or per-read stat check) instead of asserting the existing hook suffices.

### F2 — MAJOR: E5.3 budget gating silently dropped (§6, §9)
Plan E5.3: "Учесть фактический расход… исключить двойное списание, **ограничить новые запуски доступным бюджетом**; при неизвестном расходе не показывать фиктивный точный итог." PRODUCT acceptance scenario: "consultation/spend limits".
TECH §6 covers idempotent keyed charging and `"usage": "unknown"`, §9 lists `consultantDeadlineMs`/`maxRounds`/`maxParallelConsultants` — but no statement anywhere limits **new** consultant launches by remaining budget. The spend-limit half of the scenario is unimplemented by this architecture. Keyed idempotency (`chargeKeyed`) is real new work against `GoalAccounting.charge()`'s interval semantics (goal-accounting.ts:5–7, 49–54: single wall-clock baseline, per-goal) — correctly marked — but budget gating must be added or the deviation from E5.3 stated explicitly.

### F3 — MAJOR: §7 "shared round cap" does not exist; caps are per-fingerprint (task item 4/§7)
TECH §7: decision fingerprints are "stored in the same per-goal attempt-ledger **so combined question→oracle→question loops hit the shared round cap**."
Evidence: the only existing cap is `maxFailedAttemptsPerBlocker`, counted **per blocker fingerprint** — `oracleStateForFingerprint(events, goalId, fingerprint)` reconstructs per-fingerprint state (goal-oracle.ts:87–91), and the cap check uses `consult.failedAttempts` for that fingerprint (goal-core-tools.ts:341). Successes are deduped per fingerprint ("one successful consultation per blocker fingerprint", goal-oracle.ts:11). Since TECH deliberately puts decision fingerprints in a distinct space (`decision:<goalId>:<hash…>`), alternating fork→decision→fork→oracle gets each fingerprint a fresh budget: the ping-pong PRODUCT forbids ("a fork cannot ping-pong question→oracle→question; consultation attempts are bounded") is not prevented by ledger sharing alone. Sharing a ledger does not create a shared counter. TECH must define the per-goal cross-route consultation budget as new work.

### F4 — MAJOR: context minimization / log filtering / prompt-injection tests are absent (task item 1, 7)
PRODUCT "Open items for TECH.md": "context minimization, log filtering and prompt-injection tests for read-only consultants" — explicitly delegated to this document. Consultants section (§5) and test plan (§10) say nothing on any of the three. PRODUCT also states "Reading files never guarantees confidentiality of their contents" — the mitigation duties land in TECH and are missing. (The read-only tool profile itself is correctly carried over: `tools: ["read","grep","find","ls", submit]` matches goal-oracle.ts:269.)

### F5 — MINOR: DecisionRecord status transitions incomplete (task item 3)
§3 defines `status: "open"|"decided"|"escalated"|"invalidated"` but not who writes each transition when, and `open` has no exit for non-terminal endings: advisory dialog cancelled (today's meaning = blocker ladder, §8) leaves the record `open`; a superseded `activeDecisionId` after a fresh re-entry (`activeDecisionsPerGoal: 1` replaces it) leaves the old record `open` with no `superseded`/`expired` transition; goal completion/archival with a pending record is unspecified. Terminal-status writers (acceptance guard ⇒ `decided`, escalation ⇒ `escalated`, guard rejection ⇒ `invalidated`) are inferable but not stated per transition.

### F6 — MINOR: `outcome.source` drops `consultant` from PRODUCT's log field list
PRODUCT: "chosen option, source (`agent`/`human`/**`consultant`)**" and "a consultant answer is recorded as consultant-sourced, never as the owner's." TECH §3: `source: "agent"|"human"`; §4 always returns source `agent` in bounded-auto even when the chosen option is adopted verbatim from a consultant payload. The schema cannot represent consultant-sourced outcomes — silent narrowing of an exactly-specified field list.

### F7 — MINOR: E5.1 "owner/generation" binding omitted (task item 4)
Plan E5.1: "Привязать результаты к decision ID, конкретному child ID, **owner/generation** и актуальности контекста." TECH §6 binds decisionId / childRunId / settings-snapshot / objective-hash; `generation` is a real existing concept (goal-scheduler-state.ts:44 `text(s.owner) … text(s.generation)`). activeDecisionId likely covers the intent, but the omission is unstated — either bind or mark the substitution explicitly.

### F8 — MINOR: conservative materiality narrowed to 4 string-match categories (task item 1)
PRODUCT defines material as "hard to reverse, affects money/data/production/security, **or departs from the literal request**" with a conservative default ("when unsure treat as material") and says "classification rules are fixed in TECH.md." TECH §4 fixes only the four forbidden categories (money/data-deletion/production/secrets) + unknowns⇒research floor; "hard to reverse" and "departs from literal request" have no mechanical rule and the conservative default is absent from the validator. The "string match is best-effort" note covers semantic adequacy of the request, not the missing materiality axes.

### F9 — MINOR: unit test-plan gaps vs PRODUCT acceptance scenarios (task item 7)
Correctly deferred to E7: direct/research/critique end-to-end, delegation, prohibitions, no-UI, confirmations/task-tree autonomy. But these are unit-testable and absent from §10: maxParallelConsultants=2 enforcement (§5 promises it, nothing tests it); project isolation (plan E2.1 explicitly requires "изоляции проектов" tests); restart-mid-consultant ⇒ `invalidated`; no-false-invalidation from unrelated task-tree changes (§3 behavior, no test); cross-session disable (impossible until F1 is fixed). Malformed output, deadline, abort, model-unavailable, guard matrix, idempotent accounting, fingerprint non-collision, manual no-op, old-settings load are covered — good.

## Consistency checks that passed (task items 1, 4, 6)
- Advisory pipeline: §4 runs the identical consultant pipeline then prefills `runGoalQuestionnaire(recommended)` — matches PRODUCT advisory mode; user answer wins (`source: "human"`).
- ask-human fallback: §4 escalation returns `goal_question`/blocker-ladder semantics unchanged; §5 blocker objection non-waivable; mandatory-critique unavailability ⇒ ask-human (matches PRODUCT "never silently degrade").
- Cross-model rule: critic ≠ proposing model; degraded mode forbidden when critique mandatory — matches PRODUCT.
- E5.2 deliberation-inside-agent-turn: **acceptable**. Plan E5.2's demands (no blind acceptance after ambiguous failure; late results don't resume; unconfirmed-kill ⇒ orphaned) are each mapped: abort listener, orphan marking, `invalidated` on restart, out-of-order/idempotent guard. Scheduler phases untouched is consistent, since nothing crosses turn boundaries.
- §9 numbers: consistent with PRODUCT (rounds/deadline/parallel/one-active-deliberation); `decisionLogCap: 50`, excerpt 400 chars are new but unconstrained by PRODUCT/plan.
- Oracle/blocked path: §7 "runGoalBlockedFlow untouched; router never runs on blocked path in v1" — matches PRODUCT's non-goals.

## Residual risks
- F1 fix choice (fresh disk read vs stat-check vs watcher) affects settings API shape; owner should pick before implementation starts.
- F2/F3 add new acceptance-guard/ledger logic; if deferred to "v1 limitation" instead, the deviation must be written into TECH and accepted by the owner, because both trace to approved plan items (E5.3, PRODUCT interaction section).

## Fix verification r1.1
Read-only re-check of the changed sections (§2, §3, §4, §5, §9, §10) against F1–F9. No new full revision.

- **F1 — yes.** §2 now states the cache is in-process and not invalidated by another session's write, and mandates a cache-bypassing fresh disk read of `decisionMode` + snapshot id at acceptance time; §10 adds the "acceptance-time fresh mode read (cross-session switch rejects)" test. The mode decision no longer trusts the warm cache.
- **F2 — yes.** §3 adds budget gating before each consultant launch via real anchor `budgetRemaining` (goal-accounting.ts:72), refusal ⇒ `ask-human` with budget line, idempotent keyed charging and no fabricated usage retained; §10 adds the launch-refusal test.
- **F3 — yes** (mechanism), with residual note: §5 defines the new per-goal `consultationsLaunched` counter + `maxConsultationsPerGoal: 6` covering decision AND oracle launches, explicitly marked "new work, not reuse", with limit in §9 and test in §10. However, §7 still retains the original false sentence "…so combined question→oracle→question loops hit the shared round cap", which now contradicts §5. Recommend deleting the stale §7 clause; non-blocking since §5 owns and corrects the mechanism.
- **F4 — yes.** §5 adds context minimization (prompt limited to question/options/excerpt/unknowns) and log hygiene (claims + ≤300-char capped summaries, no raw dumps/secrets); §10 adds a prompt-injection fixture. All three PRODUCT-mandated items covered.
- **F5 — yes.** §3 adds `superseded`/`expired` states and a per-transition single-writer table, including cancelled advisory dialog ⇒ `escalated` and goal archival ⇒ `expired`.
- **F6 — yes.** `outcome.source` is now `"agent"|"human"|"consultant"`, matching PRODUCT's field list.
- **F7 — yes.** Record snapshots the scheduler `generation` (goal-scheduler-state.ts concept) at launch; guard requires it unchanged; added to the §10 guard matrix. E5.1 binding satisfied.
- **F8 — yes.** §4 now classifies the axes: forbidden categories = mechanical floor; "hard to reverse" / "departs from literal request" = semantic, model-classified with the conservative default (unsure ⇒ material ⇒ critique floor) and documented limit — matches PRODUCT.
- **F9 — yes.** §10 adds all previously missing unit-testable items: parallel cap enforcement, project isolation, restart mid-consultant ⇒ `invalidated`, no-false-invalidation from unrelated task-tree changes (plus the F1/F2/F3/F4 tests).

**Verdict r1.1: ok** — all nine findings resolved; sole residual is the stale contradictory sentence in §7 (cosmetic deletion recommended before owner approval). New anchors used by the fixes verified real: `budgetRemaining` (goal-accounting.ts:72), `generation` in scheduler state (goal-scheduler-state.ts:44).
