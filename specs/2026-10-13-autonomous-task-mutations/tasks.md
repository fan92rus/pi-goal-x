# Tasks: Autonomous goal task mutations

Source: PRODUCT.md / TECH.md in this directory. Status: approved by owner
("делай", 2026-10-13).

## Task list

### T1 — Settings plumbing: `autonomousTasks` (priority: P0, est. 1–2h, deps: none)

Files: `extensions/goal-settings.ts`, `tests/goal-settings.test.ts` (mirror
`disableTasks` cases).

Checklist:
- [ ] `GoalSettingsResolvedShape` + `ResolvedGoalSettings`: `autonomousTasks`.
- [ ] `ALLOWED_SETTINGS_KEYS`: `"autonomousTasks"`.
- [ ] `parseSettingsLayer`: boolean case with `asBool` + diagnostics.
- [ ] Resolution: `resolveLeaf<boolean>` with `envBool("PI_GOAL_AUTONOMOUS_TASKS")`,
      project → global → default `false`, wrapped in `track(...)`.
- [ ] Env-key mapping returns `PI_GOAL_AUTONOMOUS_TASKS`.
- [ ] Persisted round-trip copies `autonomousTasks` when defined.
- [ ] Settings status output renders a row.

Acceptance:
- Resolution order env > project > global > `false`; invalid value →
  `invalid_value` diagnostic, no crash; status row shows effective value and
  provenance; round-trip preserves the key.
- Verify: `npm run check`; settings tests green.

### T2 — Gate bypass in `set_goal_tasks` (P0, 1–2h, deps: T1)

Files: `extensions/goal-task-tools.ts`, `tests/goal-task-tools.test.ts`.

Checklist:
- [ ] Fold the two `loadGoalSettings(ctx.cwd)` calls in `execute` into one.
- [ ] `autonomousTasks === true` → skip `enterGoalModal`/`showTaskConfirmation`,
      proceed with `{ decision: "confirm" }`; apply path untouched.
- [ ] `showTaskConfirmation` itself unmodified.

Acceptance:
- With a UI-capable context and the setting on: a structural update applies
  with no dialog and no modal, result reports success; the turn is not stopped
  by a confirmation.
- With the setting off (default): existing dialog tests pass unchanged
  (byte-identical default behavior).
- Verify: `npm run check`; task-tool tests green.

### T3 — Static tool text: description + `promptGuidelines` (P1, 1h, deps: none)

Files: `extensions/goal-task-tools.ts`, `tests/goal-task-tools.test.ts`.

Checklist:
- [ ] Description: mode-neutral ("applies immediately in projects with
      autonomous task mutations; otherwise a confirmation dialog is shown"),
      no unconditional "Confirmation stops the turn".
- [ ] Guidelines: replace "Restructure an existing tree only when the user
      asks…" with permissive-but-gated wording (user asks → call immediately,
      the dialog is the user's protection; objective clearly decomposes →
      propose/maintain the tree). Keep the limits sentence.

Acceptance:
- Guard test: new wording present; old avoidance phrasing absent; limits
  sentence retained.
- Verify: `npm run check`; tests green.

### T4 — Dynamic per-turn operational line (P1, 1h, deps: T1)

Files: `extensions/prompts/goal-prompts.ts`, tests covering `taskListBlock`
(goal-features / goal-prompts tests, wherever the existing blocks are pinned).

Checklist:
- [ ] `taskListBlock` (and the empty/absent task-list early return): when
      `settings.autonomousTasks` is on, append one bounded operational line
      (immediate application + proactive decomposition + add discovered work
      immediately).
- [ ] Off → output byte-identical to today.

Acceptance:
- On: line present in both the with-tasks and no-tasks paths; stays within
  fragment budget (single sentence). Off: goldens unchanged.
- Verify: `npm run check`; prompt tests green.

### T5 — `create_goal` bootstrap line, mode-aware (P2, 30m, deps: T1)

Files: `extensions/goal-core-tools.ts`, tests covering the bootstrap line.

Checklist:
- [ ] When `autonomousTasks` is on, the derived-steps tail states the proposal
      applies immediately without confirmation; off → current wording.

Acceptance: both wordings asserted; `deriveTasksFromObjective` untouched.
Verify: `npm run check`; tests green.

### T6 — Docs & release (P2, 30m, deps: T2–T5)

Files: `README.md` (Settings section, one line), `CHANGELOG.md` (Unreleased).

Acceptance: README gains exactly one Settings-section line; CHANGELOG entry
present; no other README changes.

## Requirement coverage

| Requirement (PRODUCT.md) | Tasks |
|---|---|
| `autonomousTasks` setting, layered, default off | T1 |
| Mode on: immediate structural mutation, no dialog/turn stop | T2 |
| Mode off: byte-identical behavior, softened policy wording | T2, T3 |
| Agent ergonomics: triggers/examples line, bootstrap wording | T3, T4, T5 |
| Transparency & guardrails unchanged | T2 (asserts), T3 (limits kept) |
| Docs/release hygiene | T6 |

## Readiness check

- Requirements covered by design: yes (TECH.md §1–§5).
- Must-have requirements mapped: yes (table above).
- Open questions: none blocking.
- Verification commands known: `npm run check`, `npm test`,
  `npm run test:integration` (+ manual UI check for dialog appearance).
