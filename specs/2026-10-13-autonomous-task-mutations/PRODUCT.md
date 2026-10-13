# Product: Autonomous goal task mutations (`autonomousTasks`)

## Status

Confirmed direction (2026-10-13), implementation not started.

## Motivation

The goal extension's task tree is currently hostile to autonomous decomposition,
in two independent ways:

1. **Gate friction.** Every structural change (`set_goal_tasks`) opens a
   confirmation dialog and stops the turn. Even in fully autonomous workflows
   (a goal like "find bugs in `<module>` and fix them"), the agent cannot add
   stages or subtasks without interrupting the user.
2. **Policy friction.** The agent is reluctant to mutate the tree even when the
   user confirms. The tool's `promptGuidelines` say "Restructure an existing
   tree only when the user asks or requirements structurally change" — the model
   reads this as avoidance policy. The description announces "Confirmation stops
   the turn", which marks the call as expensive. No guidance describes *when*
   decomposition follows from an objective, and no examples exist.

Example scenario the user wants to work: an objective like "find bugs in X"
should lead the agent to create stages/subtasks for the areas it inspects and
for each discovered bug — during execution, without asking — then keep working.
(Creating tasks in an external tracker such as bd is the agent's own decision
made with its ordinary tools; it is explicitly out of scope here.)

## Decisions made with the owner (2026-10-13)

- **Variant A:** a settings mode on the existing `set_goal_tasks` tool. No
  separate "refine tasks" tool.
- **Scope of the switch:** project/global settings + env only. No per-goal flag.
- **Goal creation is untouched:** `propose_goal_draft` keeps its dialog; the
  user's explicit say in creating a goal is preserved.
- **Transparency stays:** the ledger entry, dashboard updates, and the tool's
  result report stay; in auto mode the report text names the mode explicitly
  ("Task list updated without confirmation (autonomousTasks)"). Default-mode
  report text is unchanged. Only the confirmation gate changes.
- **Guardrails unchanged:** ≤50 tasks, unique ids, acyclic parents,
  `subtaskDepth`, id-stable merge that preserves progress/evidence.
- **Agent ergonomics is part of the feature:** rewritten, trigger-based
  guidelines with examples, in both modes (see Behavior).

## Behavior

### New setting: `autonomousTasks` (default `false`)

Resolved like `disableTasks`: env `PI_GOAL_AUTONOMOUS_TASKS` → project settings
→ global settings → default `false`. Surfaced in the settings status output and
persisted settings round-trip like other booleans.

### Mode off (default) — current dialog, softened policy

- `set_goal_tasks` behavior is byte-identical to today: confirmation dialog,
  turn stop, id-stable merge.
- The tool's guidance changes from avoidance wording to permissive-but-gated
  wording: when the user asks for a restructure, call the tool immediately —
  the dialog is the user's protection, not a reason to hesitate; when the
  objective clearly requires decomposition, propose the tree rather than
  working without one. No behavior change is implied by wording alone.

### Mode on — immediate structural mutation

- `set_goal_tasks` applies the validated tree immediately: no dialog, no modal,
  no turn stop. Report/ledger/dashboard unchanged.
- Per-turn injected task-state context gains one operational line stating that
  task-tree mutations apply immediately in this project and that proactive
  decomposition is expected (see TECH.md for exact mechanism).
- Agent policy in this mode is trigger-based, with examples:
  - Discovery objectives ("find bugs in X", audits, investigations): create
    stages per inspection area up front; add a subtask per finding as it
    appears.
  - Multi-part objectives: decompose into ordered stages at start.
  - Newly discovered work mid-run: add the subtask immediately, don't batch,
    don't ask — the setting is the user's standing approval.
- `update_goal_task` semantics are unchanged.

### Interactions

- `disableTasks: true` → `set_goal_tasks` is unavailable; `autonomousTasks` is
  irrelevant (existing early return keeps precedence).
- `PI_GOAL_AUTO_CONFIRM` keeps its current meaning inside
  `showTaskConfirmation` (headless/benchmark auto-confirm); the new setting
  bypasses the dialog earlier and does not alter that env's behavior.
- Drafting (`propose_goal_draft`) dialogs are unaffected.

## Scope

In scope: the `autonomousTasks` setting (settings parsing/resolution/env/status/
persistence), the `set_goal_tasks` gate bypass, static tool text (description +
`promptGuidelines`) for both modes, the per-turn operational line, the
`create_goal` derived-tasks bootstrap line (mode-aware wording), tests, README
Settings-section line, CHANGELOG, docs.

Out of scope: per-goal autonomy flags, a separate refine/add-tasks tool,
changes to `update_goal_task` semantics, changes to proposal/goal-creation
dialogs, changes to validation limits (MAX_TASKS, depth, acyclicity), external
trackers (bd), auditor logic.

## Validation

- `npm run check` (tsc --noEmit): clean.
- `npm test`: green, including new tests: settings resolution (env/project/
  global/default), gate bypass in auto mode (applies without dialog), default
  mode unchanged (dialog still gates), guideline-text guards.
- `npm run test:integration`: green.
- Manual: with `autonomousTasks: true`, a restructure mid-goal does not stop
  the turn; with it off, the dialog still appears.
