# Tech: Autonomous goal task mutations (`autonomousTasks`)

Design for `specs/2026-10-13-autonomous-task-mutations/PRODUCT.md`. File-by-file,
anchored to the code as of 2026-10-13.

## 1. Settings: `extensions/goal-settings.ts`

Follow the `disableTasks` boolean pattern exactly. Touchpoints:

- `GoalSettingsResolvedShape` (~line 92): add `autonomousTasks?: boolean;`.
- `ALLOWED_SETTINGS_KEYS` (~line 331): add `"autonomousTasks"`.
- `parseSettingsLayer` boolean case (~line 397–405): add
  `"autonomousTasks"` to the case list sharing `asBool` parsing.
- Resolution (~line 725–745, next to `disableTasks`):
  `resolveLeaf<boolean>` with `envValue: envBool("PI_GOAL_AUTONOMOUS_TASKS")`,
  project/global layers, `defaultValue: false`, wrapped in `track(...)`.
- Env-key mapping (~line 1267): return `"PI_GOAL_AUTONOMOUS_TASKS"` for
  `autonomousTasks` so the settings UI can attribute env provenance.
- Persisted round-trip (~line 1223–1227): copy `autonomousTasks` into
  `persisted` when defined.
- Status output rows (~line 1288): add a row rendering the effective value.

## 2. Gate bypass: `extensions/goal-task-tools.ts` (`set_goal_tasks` execute)

Current flow (lines ~273–330): reconcile → disableTasks/status checks →
`convertFlatTasks` → build proposal text → `core.enterGoalModal()` →
`await showTaskConfirmation(...)` → `core.exitGoalModal()` → apply.

Change:

- Load settings once (the execute already calls `loadGoalSettings(ctx.cwd)`
  twice; fold to one call).
- If `settings.autonomousTasks === true`: skip `enterGoalModal`/
  `exitGoalModal` and `showTaskConfirmation` entirely; proceed with
  `decision = { decision: "confirm" }`. The apply path (GoalService.apply,
  id-stable merge) is untouched.
- `showTaskConfirmation` (extensions/goal-task-confirmation.ts) is NOT
  modified — its env/headless fallbacks keep their meaning for default mode.

## 3. Agent-facing text (static + dynamic)

Static registration text is flattened into the system prompt at
`buildSystemPrompt` time (toolSnippets + promptGuidelines); it cannot change
per settings. Two mechanisms:

- **Static, mode-neutral rewrite** in `goal-task-tools.ts`:
  - `description`: keep "with user confirmation" only for default mode by
    rewording to something like "Set or restructure the task tree. In projects
    with autonomous task mutations this applies immediately; otherwise a
    confirmation dialog (which stops the turn) is shown." Remove the absolute
    "Confirmation stops the turn" as unconditional fact.
  - `promptGuidelines`: replace "Restructure an existing tree only when the
    user asks or requirements structurally change" with permissive wording:
    when the user asks, call it immediately (the dialog is the user's
    protection); when the work is trackable in milestones, propose/maintain
    the tree rather than working without one. Keep the existing limits
    sentence (flat parent-linked input, ≤50 tasks, depth, lightweight
    placement).
- **Dynamic per-turn line** in `extensions/prompts/goal-prompts.ts`
  (`taskListBlock`, and the no-task-list path so bootstrap goals see it too):
  when `settings.autonomousTasks` is on, append one bounded line (strengthened
  2026-10-13 to standing authorization after user feedback — the objective
  must not need to grant permission):
  `autonomousTasks: the task tree is yours to manage — no permission needed in
  the objective or from the user. Decompose into stages/subtasks when work
  emerges, add discovered work immediately, restructure when priorities
  change; changes apply without confirmation.` `taskListBlock` already
  receives `settings`; the no-task-list early return needs the settings
  passed in or reloaded. Cap added chars within `MAX_PROMPT_FRAGMENT_CHARS`
  discipline (one line).
- **`create_goal` bootstrap line** (`extensions/goal-core-tools.ts` ~line
  221–224): when autonomousTasks is on, reword the tail "propose them ... if
  the user wants tracked milestones" to state that the proposal applies
  immediately without confirmation. `deriveTasksFromObjective` itself is
  unchanged.

## 4. Tests

- `tests/goal-settings*.test.ts`: parse/resolve/env mapping/default/status row
  for `autonomousTasks` (mirror `disableTasks` cases; env
  `PI_GOAL_AUTONOMOUS_TASKS` precedence over project/global).
- `tests/goal-task-tools.test.ts`:
  - auto mode: `set_goal_tasks` applies a tree with a UI-capable context
    without any dialog (assert applied state + no modal) and does not stop the
    turn (result has no terminate-like dialog side effect);
  - default mode: dialog still gates (existing tests keep passing unchanged);
  - guideline-text guards: assert the new permissive wording exists and the
    old "only when the user asks" phrasing is gone (pattern used by the
    budget-guard test in `tests/goal-drafting.test.ts`).
- `tests/goal-features.test.ts` / e2e where the context line is asserted:
  auto mode injects the operational line; off mode does not.
- Guideline/description snapshots or golden tests that pin old tool text must
  be updated deliberately (they are guard tests, not noise).

## 5. Docs and release

- `README.md`: one line in the existing Settings section only
  (`autonomousTasks` — let the agent restructure goal tasks without asking;
  default off). No other README changes (README scope rule).
- `CHANGELOG.md`: entry under Unreleased.
- `docs/`: detail/troubleshooting note if a goal-settings doc page exists;
  otherwise skip.

## Risks / notes

- Mid-session setting changes: settings cache invalidates at session
  boundaries and `before_agent_start` re-installs tool profiles every turn
  (goal-events.ts ~line 353); the gate reads settings at execute time. The
  prompt-fragment memo (`cachedPrompt` in goal-prompts.ts) keys on
  `settings?.autonomousTasks === true`, so the operational line appears
  immediately after a mid-session toggle too (review fix, 2026-10-13).
- Env format: like `PI_GOAL_DISABLE_TASKS`, only literal `true`/`false`
  strings are honored (`asBool`); other values fall through to the file
  layers rather than erroring.
- legacy-v1 rollback prompt profile also receives the operational line
  (accepted: the feature works there; the emergency A/B profile differs from
  compact-v2 only in active-prompt wording).
- Prompt-size discipline: the dynamic line is a single bounded sentence;
  `taskListBlock` already lives under `MAX_PROMPT_FRAGMENT_CHARS`.
- No migration: setting absent = `false` = current behavior byte-identical.
