# TECH — Adaptive decision-making for active goals

Status: Draft for owner approval (E1.2; follows approved `PRODUCT.md` in this directory).
Anchors are real symbols verified in 0.34.0 code; line numbers are orientation only.

## 1. Module layout (new files, repo naming style)

| File | Concern |
| --- | --- |
| `extensions/goal-decision-policy.ts` | `decisionMode` + limits: settings schema, layered resolution, normalization (mirror `goal-settings.ts` oracle pattern: allowed keys, `Resolved…Settings`, invalid ⇒ `manual`). |
| `extensions/goal-decision.ts` | Router: `goal_decision` tool registration, proposal validation, route decision, escalation text. |
| `extensions/goal-decision-consultant.ts` | Read-only consultant runner (generalized from `runBlockerOracle`): researcher/critic roles, submit-tool schemas, deadline/abort. |
| `extensions/goal-decision-record.ts` | `DecisionRecord` schema + sidecar storage (atomic write, revision field). |
| `extensions/goal-decision-runtime.ts` | Acceptance guard: identity binding, stale/duplicate filtering, pause/cancel, accounting hooks. |
| Tests: `tests/goal-decision*.test.ts` (unit, injection seams only — no real API). |

No changes to `goal-oracle.ts` behavior; its session-runner shape is copied, not imported-and-mutated.

## 2. Settings (E2.1)

```ts
interface GoalDecisionSettingsResolved {
  mode: "manual" | "advisory" | "bounded-auto";   // default "manual"
  critic?: { provider?: string; model?: string; thinkingLevel?: string };
  limits: { maxRounds: 2; consultantDeadlineMs: 120_000; maxParallelConsultants: 2 };
}
```

File keys (resolved with owner 2026-10-27, supervisor decision gx-43n.1): flat top-level `decisionMode`, `decisionCritic`, `decisionLimits` — literal to PRODUCT's `decisionMode` setting name. The resolved shape above is the module's API, not the file layout.

- Layered like existing settings (owner revision 2026-10-27, post-E7): built-in default → global → project for ALL keys, per-key precedence identical to `resolveLeaf` in goal-settings.ts (a key set in a higher layer wins; an absent key falls through). The global file MAY define a default `decisionMode`; the project file overrides it; a goal still cannot set its own mode (PRODUCT: never per goal). A present-but-invalid mode string in the effective layer normalizes to `manual` (fail-safe, no fallthrough past an explicitly set key). A JSON `null` value is treated as the key being absent (consistent with goal-settings layer parsing).
- Unknown/invalid values normalize to `manual` + limits defaults (fail-safe to today's behavior).
- **Cross-session freshness (acceptance-time):** the settings cache (`settingsFileCache`) is in-process and is NOT invalidated by another session's write. Therefore the acceptance guard never trusts the warm cache for the mode decision: it reads BOTH settings files fresh from disk (cache-bypassing `decisionMode` resolution over global + project + snapshot id) at acceptance time. Cost is two small file reads per deliberation acceptance, not per turn. Same-process edits keep the existing invalidate hook; other keys (limits, critic) may be served from the resolved snapshot captured at deliberation start.
- **Snapshot semantics:** `snapshotId = sha256(raw global file text || NUL || raw project file text)[0:16]`; a missing file contributes the same bytes as an empty file (`sha256("")` slot semantics preserved for the project-only history). Covers BOTH files so a mid-deliberation edit of either invalidates. Limits normalize per key: an invalid key falls back to that key's default; the whole `decisionLimits` falls back to defaults only when the value is not an object.

## 3. DecisionRecord (E2.2)

```ts
interface DecisionRecord {
  id: string;                 // "dec-<rand>"
  goalId: string;
  createdAt: string;
  requestAnchor: {            // authority provenance (PRODUCT)
    objectiveExcerpt: string; // ≤400 chars, from the goal objective at decision time
    objectiveHash: string;    // sha256, staleness detection
  };
  policyVersion: string;      // settings snapshot id used for the run
  question: string;
  options: string[];
  route: "direct"|"research"|"critique"|"research+critique"|"ask-human";
  routeJustification: { skipped: string[]; reasons: Record<string,string> };
  authorityBasis: string;     // why the original request covers this choice
  facts: string[]; unknowns: string[];
  consultants: ConsultantResult[];  // {role, childRunId, model, usage, summary, schemaPayload}
  outcome?: { chosen?: string; source: "agent"|"human"|"consultant"; risks: string[]; revisitWhen?: string };
  status: "open"|"decided"|"escalated"|"superseded"|"expired"|"invalidated";
}
```

- Storage: sidecar per goal in goal storage root (`decisions/<goalId>.json`, array capped at 50, oldest evicted — including `open` records; with `activeDecisionsPerGoal: 1` this is unreachable in practice), atomic write with `revision`. `GoalRecord` gains only `activeDecisionId?: string` — keeps the per-turn injected record small. The store is deliberately **permissive about field lengths**: caps (≤300 chars/field, array element limits) are enforced by the router at the write boundary (E3/E4), not by the store (owner decision 2026-10-27).
- Status transitions (single writer each): `open` → `decided` (acceptance guard, bounded-auto resolution); → `escalated` (router escalation, including cancelled advisory dialog — falls back to blocker ladder); → `superseded` (a new deliberation replaces `activeDecisionId`); → `expired` (goal completed/archived with the record open); → `invalidated` (guard rejection: stale identity, settings/objective change, pause/restart, schema failure). Only the acceptance guard writes `decided`/`invalidated`; only the router writes `escalated`/`superseded`; archival writes `expired`.
- Objective hash mismatch on acceptance ⇒ premise changed ⇒ result invalidated (plan E5.1); unrelated task-tree changes do not touch the record (PRODUCT). The record also snapshots the goal's scheduler `generation` (same concept as `goal-scheduler-state.ts`) at launch; acceptance requires it unchanged — pause/interrupt invalidates, satisfying plan E5.1's owner/generation binding.
- The objective itself is never rewritten into the record beyond the excerpt+hash; consultants never replace it (plan E2.2).
- **Consultant budget gating (plan E5.3):** before each consultant launch the runner checks the goal's remaining token budget (`budgetRemaining`); launch proceeds only if remaining > 0 (or no budget set). A launch refused by budget ends the route and returns `ask-human` with the budget line — never a silent skip. Actual usage is charged per `childRunId` as below; unknown usage never fabricates numbers.

## 4. Router & tool surface (E3, E6)

- New tool `goal_decision`, registered **only** when resolved mode ≠ `manual` and a goal is active (reuse `applicableGoalTools` visibility pattern). `manual` registers nothing ⇒ byte-for-byte today. Validator mechanics: forbidden categories (money/data-deletion/production/secrets) are a mechanical floor; the materiality axes "hard to reverse" and "departs from the literal request" are semantic — the proposing model classifies them, the conservative default applies (unsure ⇒ material ⇒ critique floor), and this limitation is documented (PRODUCT).
- Input schema (what the model submits): question, options, self-assessed route, authority basis, skip justifications, facts/unknowns. Validator (code, not model): required fields present; route ≥ policy floor (material ⇒ critique floor, not skippable by skipJustifications.critique (E7.3); unknowns ⇒ research floor, skippable only with a justification); authority basis non-empty; forbidden categories (money/data-deletion/production/secrets) never resolve below `ask-human` unless request clearly covers them (string match is a best-effort barrier; semantic limit documented).
- Outcomes:
  - `bounded-auto` + validated → run consultants per route → acceptance guard → return resolution text (chosen option, source `agent`, risks, revisit) → model continues.
  - `advisory` → identical pipeline, then open the existing questionnaire dialog with the recommendation prefilled (`recommended` index); user answer wins, source `human`.
  - Any escalation → return `ask-human` instruction; model falls back to `goal_question`/blocker ladder (unchanged semantics).
- `goal_question` / `goal_questionnaire` (goal-drafting.ts) stay untouched; draft-phase flows never invoke the router (mode applies to active goals only).
- Lifecycle prompt (`goal-core-tools.ts` ~:122) and tool descriptions updated in the same change set so the model routes forks through `goal_decision` when available.

## 5. Consultants (E4)

- `runConsultant(args)` copied from `runBlockerOracle` shape: fresh in-memory session, `tools: ["read","grep","find","ls", submit]`, custom submit tool, `SessionManager.inMemory`, compaction off, injectable `createSession` seam for tests, AbortSignal + deadline timer (default 120s), model resolution like `resolveOracleModel` (settings override).
- Roles/schemas:
  - researcher → `{findings:[{claim,evidence,source}], remainingUnknowns:[], verdict: "answered"|"insufficient"}`;
  - critic → `{objections:[{severity:"blocker"|"major"|"minor", evidence}], verdict: "sound"|"unsound"}`.
- Cross-model rule: critic model ≠ proposing session's model. Default critic = `decision.critic` settings. **Owner amendment (2026-10-27, E4.2 review): v1 is strictly fail-closed** — unset critic, model not in registry, or critic == author model ⇒ no critique: mandatory critique ⇒ `ask-human`; optional critique ⇒ `ask-human` too (same-model critique is confirmation, not verification; a model registry for "same-provider alternate" does not exist in the extension runtime). The `crossModelDegraded` mode and fallback chain are deferred to E6+ when a model resolver exists.
- Route escalation mid-flight: researcher `verdict:"insufficient"` or critic blocker objection ⇒ route escalates (critique added, or `ask-human`); a blocker objection can never be waived (PRODUCT). Max 2 rounds total; exceeded ⇒ `ask-human`.
- **Cross-route consultation cap (PRODUCT anti-ping-pong):** the oracle's `maxFailedAttemptsPerBlocker` is per-fingerprint and does NOT bound decision↔oracle alternation. New per-goal counter `consultationsLaunched` in the decision sidecar increments on every consultant launch (decision router AND blocker-oracle consultations) with a hard cap `maxConsultationsPerGoal` (default 6); at the cap the router returns `ask-human` and the oracle path behaves as today (its own per-fingerprint cap unchanged). This is new work, not reuse.
- **Context minimization & log hygiene:** consultant prompts contain only question, options, objective excerpt and the specific unknowns — never the full goal record or unrelated files. Ledger events and the decision log store claims and capped summaries (≤300 chars per field), not raw tool output, file dumps, or secrets that passed through reads.
- Parallel research sessions allowed (≤2); critic starts only after the proposal is fixed.

## 6. Runtime acceptance guard (E5)

Accepted only when ALL hold: `decisionId` matches goal's `activeDecisionId`; `childRunId` not already settled (idempotent, out-of-order duplicates ignored); settings snapshot id equals current resolved snapshot (mode switch ⇒ reject); objective hash unchanged; consultant payload passed schema validation; not past deadline; goal not paused/cancelled (abort listener cancels in-flight sessions; un-cancellable children are marked `orphaned` in the record — never silently awaited).

Pause/restart: `GoalScheduler` phases untouched; deliberation lives inside the agent turn (awaited tool call), so scheduler `wait/signal` is not involved in v1. Restart mid-consultant ⇒ session lost ⇒ record status `invalidated`, no auto-restart of consultants after restore (safe re-entry: model may start a fresh deliberation).

Accounting: consultant session usage captured via the session event subscription (factory `subscribe`) keyed by `childRunId`; charges passed to `GoalAccounting` as keyed events (new `chargeKeyed(childRunId, tokens, seconds)`) — repeated delivery of the same `childRunId` never double-charges; unknown usage (event loss) is reported as `"usage": "unknown"`, never a fabricated number (plan E5.3).

## 7. Oracle / blocked-path compatibility (E6.2)

- Decision fingerprint space: `decision:<goalId>:<hash(question + options + objectiveHash)>` — distinct from the oracle's blocker fingerprint, but recorded in the same per-goal attempt-ledger; the combined round budget is the §5 cross-route cap (`maxConsultationsPerGoal`), not a shared fingerprint counter.
- `update_goal(blocked)` and `runGoalBlockedFlow` untouched; the router never runs on the blocked path in v1.

## 8. Journal & UI (E6.3)

- Each terminal state appends a ledger event (`decision_recorded`) and writes the DecisionRecord; the widget/status view gets a compact last-decision line via existing status assembly (fields exactly per PRODUCT).
- Advisory dialog: reuse `runGoalQuestionnaire` with `recommended` set; cancellation keeps today's meaning.

## 9. Numeric limits (proposed — owner approves with TECH)

maxRounds 2 · consultantDeadlineMs 120 000 · maxParallelConsultants 2 · activeDecisionsPerGoal 1 · decisionLogCap 50 · objectiveExcerpt 400 chars · maxConsultationsPerGoal 6.

## 10. Test plan (unit, deterministic)

Policy normalization/layering/invalid→manual; acceptance-time fresh mode read (cross-session switch rejects); `goal_decision` visibility per mode; validator table (route floors, forbidden categories, missing basis); consultant runner via injected session (deadline, abort, invalid payload, model unavailable); **parallel cap enforcement (≤2 live consultants)**; acceptance guard matrix (duplicate/stale/out-of-order/paused/mode-switch/objective-hash/generation); accounting keyed idempotency + budget-gated launch refusal; cross-route consultation cap; oracle fingerprint non-collision; manual-mode no-op (dedup integration registers nothing); old settings/goals load unchanged; **project isolation (two projects, different modes)**; **restart mid-consultant ⇒ `invalidated`, no auto-restart**; **no false invalidation from unrelated task-tree change**; advisory dialog passthrough; prompt-injection fixture (instructions planted in read files do not alter consultant schema output or route). Integration/e2e and live scenarios per plan E7, separate from unit suite.
