# Adaptive decisions

Adaptive decisions let an active goal resolve a technical fork (one of several valid options, such as library versus hand-rolled or sequential versus parallel) from the user's original request, instead of stopping to ask. Every decision is recorded with its rationale. Anything that lacks authority, verified facts, or a clean critique goes back to the owner through `goal_question`.

The feature is opt-in and project-scoped. With the default mode nothing changes: no tool is registered, no routing text is added to the prompt, and the question and blocker paths behave as before.

## Enable

Set the mode in the project settings file `.pi/pi-goal-x-settings.json`:

```json
{ "decisionMode": "advisory" }
```

The global file `~/.pi/agent/pi-goal-x-settings.json` may define a default `decisionMode` (plus shared `decisionCritic`/`decisionLimits`); the project file overrides it per key.

- Resolution per key: project > global > built-in default (the same project > global precedence as other goal-x options; decision keys have no environment layer). A goal cannot set its own mode.
- An unknown value in the effective layer is treated as `manual` (an explicitly set invalid project value does not fall through to global).
- The setting is applied to every goal and session of the project. Changing it takes effect before the next decision result is accepted. Switching to `manual` stops autonomous acceptance for a deliberation still in progress; decisions already accepted stay accepted and remain in the log.

Optional keys for consultants and limits (values shown are the defaults):

```json
{
  "decisionMode": "bounded-auto",
  "decisionCritic": { "provider": "<provider>", "model": "<model>", "thinkingLevel": "<level>" },
  "decisionLimits": {
    "maxRounds": 2,
    "consultantDeadlineMs": 120000,
    "maxParallelConsultants": 2,
    "maxConsultationsPerGoal": 6
  }
}
```

Invalid limit values fall back to the default for that key.

## Modes

| Mode | Behavior at a fork |
| --- | --- |
| `manual` (default) | Today's behavior. The agent asks with `goal_question`; `goal_decision` is not registered. |
| `advisory` | The agent prepares a recommendation, optionally with research or critique, and asks the owner. The question dialog opens with the recommended option pre-selected. The owner's answer is recorded as human-decided. No decision is taken without an answer. |
| `bounded-auto` | The agent decides and continues when the request covers the choice and the route passes. Everything else escalates to `goal_question`. |

`goal_decision` is registered only when the mode is not `manual` and a goal is active. Pi tools cannot be unregistered, so the tool stays available for the rest of the session once registered; it is advertised only while a goal is active.

## Routes

The agent proposes a route; the router computes the floor and never lowers it.

| Route | Meaning |
| --- | --- |
| `direct` | No consultants. Allowed when the choice is clear from the request and no unknown or material risk applies. |
| `research` | One or more read-only researchers gather facts for a specific unknown. |
| `critique` | A read-only critic reviews the proposal. |
| `research+critique` | Research first, then critique. |
| `ask-human` | Escalates immediately: the agent falls back to `goal_question` or the blocker ladder. |

Floors computed by the code:

- Any unknown requires at least `research`.
- A material decision requires `critique`. A decision is material unless the proposal explicitly sets `materialRisk: false`; an absent value counts as material.
- A forbidden category (money, data deletion, production, or secrets, matched by keyword in the question, options, facts, or unknowns) forces `ask-human`. No justification waives it.

Skipping a consultation:

- A required research step can be skipped only with a non-empty `skipJustifications.research`, which is recorded.
- Critique required by the floor is never skipped. A `skipJustifications.critique` entry does not waive it, so a material decision without a critic escalates.

Consultants:

- Researchers and the critic run in fresh, read-only sessions with `read`, `grep`, `find`, and `ls` plus one submit tool. They have no write, edit, bash, or delegation tools.
- A researcher returns findings and a verdict (`answered` or `insufficient`). An `insufficient` verdict, a malformed payload, or a failed or cancelled consultant escalates to `ask-human`.
- The critic returns objections with severity `blocker`, `major`, or `minor`, and a verdict of `sound` or `unsound`. A blocker objection always escalates; it cannot be waived.
- The critic must be configured in `decisionCritic` and must differ from the proposing model. If it is not configured, cannot be resolved, or matches the author, critique is unavailable and the route escalates. The executor model is never used as critic.

Escalation text tells the agent to ask with `goal_question`. Escalation never auto-approves: in a headless session without authority grounds, the goal waits for a human.

## How authority derives from the original request

- Authority comes from the goal's objective and the user's explicit constraints, not from a per-choice allowlist. A clearly delegated piece of work may be decided internally without asking again.
- The proposal must state an `authorityBasis`: why the original request covers this choice. A blank basis is rejected. The record stores the objective excerpt (at most 400 characters) and a hash of the objective at decision time.
- Enabling the mode grants nothing. Instructions found in files, tool results, or consultant answers never widen authority. Consultant output is accepted only through its schema.
- Deciding how to reach the goal is in scope. Changing what the goal is (its objective, acceptance contracts, or confirmation dialogs) is not.
- Materially different readings of the request go to the owner. "It seems obvious" is not an authority check.
- The mode does not override explicit prohibitions, security rules, the sandbox, or tool permissions.
- Existing task-tree autonomy is unchanged. A task restructure does not invalidate a deliberation; a change to the objective, to the goal's scheduling generation, or to the project settings does (see limitations).

## Limits

| Limit | Default | Key |
| --- | --- | --- |
| Consultation rounds per decision (phases, not launches) | 2 | `decisionLimits.maxRounds` |
| Consultant deadline | 120 000 ms | `decisionLimits.consultantDeadlineMs` |
| Consultants running in parallel | 2 | `decisionLimits.maxParallelConsultants` |
| Consultant launches per goal, shared with the blocker oracle | 6 | `decisionLimits.maxConsultationsPerGoal` |

- When a limit is reached, the route escalates to `ask-human` before any further launch.
- The token budget gates every launch. With no budget left, the launch is refused and the route ends `ask-human` with the budget line.
- A consultant that outlives its cancellation by more than 5 000 ms is recorded as `orphaned` and is not awaited further.
- Consultant usage is charged to the goal under a decision-scoped key, so a repeated charge does not double-count.

## Record and journal

Every terminal state of a decision is recorded and journaled as one `decision_recorded` ledger entry with:

- the route and why it was chosen;
- a link to the original request (the objective hash);
- the chosen option and its source (`agent`, `human`, or `consultant`);
- key risks, the revisit condition, and the consultant tokens spent or `unknown`.

The per-goal record file lives in the goal storage root (`decisions/<goalId>.json`, capped at 50 entries). The most recent decision appears as one `Decision <id> <status>` line in the dashboard and `/goal-status`. Statuses are `decided`, `escalated`, `superseded`, `expired`, and `invalidated`.

On `session_start`, open records of the goal are invalidated as `restarted`. Nothing is relaunched: the agent may start a fresh deliberation.

## Limitations

These limits are part of the feature, not hidden defects. They were verified by the scenario and fault-injection acceptance suite (`tests/goal-decision-acceptance.test.ts`); the matrix and residual risks are in `specs/2026-10-27-adaptive-decisions/MATRIX.md`.

Semantic judgement is not mechanical:

- Materiality (`materialRisk`), whether the choice goes beyond the original request (`selfRoute: "ask-human"`), and whether an explicit user preference is honored are classified by the proposing model. The code checks only presence, floors, and the conservative default (an absent `materialRisk` is material). Only an explicit `false` lowers the floor.
- The forbidden-category check is keyword matching. A proposal that describes a money, deletion, production, or secret decision without these words is not caught by the code.
- The real model's behavior on adversarial file content is not tested. Acceptance uses a scripted consultant session; the code-side invariants are checked (schema-only fields, a router-computed route, a blocker never waived, the mode resolved fresh across both files per key).

Runtime boundaries:

- The per-result acceptance guard and the `activeDecisionId` binding are not on the production tool path yet. Consultants are awaited inside the tool call, so duplicate or late deliveries cannot reach the tool; the resolution-level guard (mode, objective, generation, settings snapshot) is enforced.
- There is no single-deliberation-per-goal guard. Two deliberations for the same goal can interleave; each counts against `maxConsultationsPerGoal`.
- A direct `bounded-auto` decision has no deliberation window; its mode is read when the call starts.
- Any project settings edit, even of an unrelated key, invalidates a deliberation in flight. This is conservative; task-tree edits do not invalidate it.
- A cancelled or timed-out consultant reports unknown usage even when some usage events arrived, so partial tokens are not charged. This under-counts and never fabricates a number.
- A failed write can leave an open record. It is never accepted in the same session and is invalidated at the next `session_start`.
- A corrupt sidecar found at `session_start` is skipped silently by the restart invalidation; the next `goal_decision` reports the typed error.
- A failing consultant escalates at once rather than after the second round.
- Without a UI, advisory mode cannot open the dialog; the record falls back to the no-answer meaning and the blocker ladder.
