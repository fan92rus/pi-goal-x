# Milestones

## 2026-10-13 — Spec confirmed (no code yet)

Direction settled in conversation with the owner:

- Variant A chosen: settings mode on the existing `set_goal_tasks`; no
  separate refine tool, no per-goal flag.
- Owner added the ergonomics requirement mid-exploration: the agent is
  reluctant to mutate the tree even with confirmation, so rewritten
  tool guidance (trigger-based, examples) is in scope for both modes, not
  just the auto gate.
- bd integration explicitly out of scope (agent's own decision via its
  ordinary tools).
- Fact-check pass over code before writing TECH.md:
  - tool profiles re-install every turn (`before_agent_start`) and on
    settings changes; descriptions/promptGuidelines are static per
    registration → static rewrite + dynamic per-turn line design;
  - `showTaskConfirmation` env/headless fallbacks (PI_GOAL_AUTO_CONFIRM)
    keep current meaning; the new setting bypasses earlier;
  - settings follow the `disableTasks` boolean pattern (six touchpoints in
    goal-settings.ts).

Implementation not started. Next: tasks per TECH.md §1–§5.

## 2026-10-13 — Implemented (T1–T6), gates run

- T1 settings: `autonomousTasks` across GoalSettingsResolvedShape,
  ALLOWED_SETTINGS_KEYS, parse case, resolveLeaf+track with env
  `PI_GOAL_AUTONOMOUS_TASKS`, resolutionEnvKeys (cache invalidation —
  touchpoint found during implementation, not in TECH §1), value object,
  buildPersistedLayer, envOverrideFor, effectiveSettingsReport row, and the
  /goal-settings menu row (boolean, generic toggle path).
- T2 gate: set_goal_tasks folds the duplicate loadGoalSettings and, when
  autonomousTasks, skips enterGoalModal/showTaskConfirmation, skips
  markTurnStopped and `terminate: true` — the turn continues after apply.
  Default mode byte-identical (existing terminate assertion still passes).
- T3 text: description is mode-aware (no unconditional "Confirmation stops
  the turn"); guidelines rewritten permissive-but-gated with decomposition
  triggers; limits sentence kept.
- T4 dynamic line: one bounded operational line appended to taskListBlock,
  also returned standalone when the tree is still empty (decomposition
  starts from no tasks). Off → byte-identical.
- T5 bootstrap: create_goal derived-steps nudge states immediate application
  when autonomousTasks is on.
- T6: README Settings row; CHANGELOG Unreleased entry.
- Deliberate golden updates: integration "displays every persisted settings
  row" 20 → 21 rows + autonomousTasks row assertion (menu label includes the
  explanatory parenthetical).
- Gates: `npm run check` clean. Full unit suite via direct invocation
  (`node --experimental-strip-types --import ./scripts/test-adapter-hooks.mjs
  --test tests/*.test.ts`): 1051/1064; the 13 failures are byte-identical to
  clean HEAD on this Windows box (shell harness, settings race, checkpoint
  recovery, golden objective parse, ledger path, chmod scoped mutation,
  /tmp path prefix — all environmental; `npm test` itself is broken on HEAD
  here: the runner passes `D:\...` absolute paths to `--test`, 77/77 ERR
 _UNSUPPORTED_ESM_URL_SCHEME). Integration: 30/31 (the 1 failure
  pre-existing on HEAD). New tests: 12, all green.
- Review verdict: ГОДЕН (independent glm-5.3 review, refute-protocol, tests
  and mutations run independently; numbers reproduced 1:1).
- Review fix (minor, demonstrated): `cachedPrompt` fragment-memo key omitted
  `settings?.autonomousTasks` — a mid-session toggle left the stale cached
  block until the next tree/goal mutation. Key now includes the setting;
  regression test added (goalPrompt off→on toggle). TECH.md risks updated.
- Nits applied: proposal text is no longer built in autonomous mode;
  PRODUCT.md clarifies the auto-mode result text names the mode; TECH.md
  documents the true/false-only env convention and the legacy-v1 note.
- Final gates after fixes: `npm run check` clean; unit 1052/1065 (13 fails =
  exact HEAD baseline); integration 30/31 (1 pre-existing); regression test
  green.
- Committed as feat: autonomous goal task mutations (autonomousTasks).

## 2026-10-13 (later): standing authorization wording

- User feedback: with autonomousTasks on, the agent still hesitated unless the
  objective itself granted permission — the shipped line gated decomposition
  on "when the objective implies it".
- Strengthened to standing authorization: the per-turn line now states the
  task tree is the agent's to manage, no permission needed in the objective or
  from the user; decompose when work emerges, add discovered work immediately,
  restructure when priorities change. Tool guideline 1 no longer references
  the objective's wording ("work trackable in stages" instead of "objective
  clearly decomposes").
- Files: extensions/prompts/goal-prompts.ts, extensions/goal-task-tools.ts,
  tests/goal-prompts.test.ts; spec PRODUCT/TECH updated to the new wording.
- Mode off stays byte-identical; tool description remains mode-neutral.
