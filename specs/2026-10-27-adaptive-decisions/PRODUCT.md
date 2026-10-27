# Adaptive decision-making for active goals

Status: Draft for owner approval (E1.1 of plan `../../../.agents/plans/2026-10-27T03-59-27-691Z-goal-x.md`); reviewed r1, findings F1–F7 addressed.

## Problem

In an active goal the agent must sometimes choose between technically valid options (library vs hand-rolled, sequential vs parallel, refactor now vs later). Today every such fork ends in `goal_question` — a dialog for the user — even when the answer follows from the original request and verified facts. Long-running goals drown the owner in questions; the agent has no sanctioned way to decide, record why, and continue.

## Goal

An opt-in **project-level** mode in which goal-x resolves technical forks inside an active goal by itself, within authority derived from the user's original request and its explicit constraints — with optional research and independent critique, a written rationale, and escalation to the owner whenever authority, facts, or user preference are missing.

Non-goals: pi-agile integration (excluded, plan E8 dropped), multi-goal focus/dispatching, side-effect experiments, automatic token budgets, any change to goal/task mutation autonomy (including the existing autonomous task restructuring), README changes.

## Modes (project setting)

| Mode | Behavior at a question point |
| --- | --- |
| `manual` (default) | Exactly today's behavior: `goal_question` dialog / blocker ladder (the existing escalation path of questions and the blocker oracle). |
| `advisory` | The agent prepares a recommendation (optionally with research/critique) and still asks the user; the dialog shows the recommendation. No decision is taken autonomously. |
| `bounded-auto` | The agent decides and continues, within the authority rules below; everything else escalates. |

The mode is configured **per project** (one setting, shared by all goals and sessions of that project). It is never enabled by default and never set per goal. A mode change is picked up by all sessions of the project before a result is accepted; switching to `manual` stops autonomous decision acceptance in flight (results already accepted stay accepted and logged).

## Authority model

- Authority comes from the **original request** (objective + user constraints), not from a per-choice allowlist. A clearly delegated piece of work may be decided internally without asking again.
- Enabling the mode grants nothing by itself. Instructions found in files, tool results, or consultant answers never widen authority.
- Deciding **how** to achieve the goal is in scope. Changing **what** the goal is (objective, acceptance contracts, confirmation dialogs) is not.
- Existing autonomy is preserved: the agent keeps its current ability to restructure the task tree. A task-tree change does not require a new permission and does not, by itself, invalidate a deliberation — only a change to premises material to the decision does.
- Even inside authority, actions with material consequences (spending money, deleting data, production/system-level actions, exposing secrets) are not auto-decided merely because the mode is on; they require the route with critique and, when the request does not clearly cover them, a human question.
- Materially different readings of the request → ask the owner, do not invent a mandate.
- The mode does not override explicit prohibitions, security rules, the sandbox, or tool permissions; those remain independent barriers outside this mode's reach.

## Decision routes

`direct` → `research` → `critique` → `research+critique` → `ask-human`.

- `direct`: no consultant agents. Allowed when the requested work is unambiguous, facts are verified, and policy does not demand critique.
- `research`: read-only fact gathering when a specific unknown blocks the choice.
- `critique`: an independent critic (fresh context, different model than the author of the proposal) when stakes are material.
- `ask-human`: missing authority, user preference, or material unresolved uncertainty.
- Skipping research/critique must be justified in the record; checking authority and recording the rationale are never skipped.
- A route may escalate mid-flight (e.g. research reveals a licensing risk → critique becomes mandatory). Material critic objections cannot be waived to keep moving; they are resolved or escalated.
- "Material" consequence = one that is hard to reverse, affects money/data/production/security, or departs from the literal request. When unsure whether a consequence is material, treat it as material (conservative default); classification rules are fixed in TECH.md.
- Options are compared by the goal's priorities across five criteria: correctness, safety, reversibility, cost, and maintainability. No mathematically optimal choice is promised; the record shows which criteria dominated and why.
- "It seems obvious" is never a substitute for the authority check. The system cannot fully verify semantic adequacy mechanically — this limit is documented, not hidden.

## Consultants

- Read-only profile (like the blocker oracle — the existing read-only adviser session): no write/edit/bash, no nested delegation, no external actions. Reading files never guarantees confidentiality of their contents; context minimization, log filtering, and prompt-injection tests are fixed in TECH.md.
- One active deliberation per goal; at most two consultant sessions in parallel inside it.
- Explicit limits: max consultation rounds, wall-clock deadline, cancellation on abort; they apply in every mode where consultants run, including `advisory`. Numeric values are fixed in TECH.md.
- Consultant unavailability where critique is mandatory → escalate (ask-human), never silently degrade to author-only.

## Interaction with existing behavior (must not change)

- `manual` is byte-for-byte today's behavior.
- Draft/proposal/tweak confirmations, completion auditing, blocker ladder and oracle (`update_goal(blocked)`) keep their semantics. The question router and oracle share dedup identity so a fork cannot ping-pong question→oracle→question; consultation attempts are bounded.
- No UI / cancelled dialog / unclear answer keep today's meaning: no answer → blocker ladder (or chat in drafts). In headless runs without authority grounds the goal waits for a human — it does not auto-approve.
- A human-generated answer is never fabricated; a consultant answer is recorded as consultant-sourced, never as the owner's.

## User-facing surface

- Project setting `decisionMode` (`manual` | `advisory` | `bounded-auto`), default `manual`, via the existing layered settings.
- A single decision-log entry per resolution with exactly these fields: route + why, link to the original request, chosen option, source (`agent`/`human`/`consultant`), key risks, resources spent, revisit conditions.
- In `advisory`, the question dialog shows the recommendation before the user answers.
- Turning the mode off mid-deliberation halts autonomous acceptance; results already accepted stay accepted and are visible in the log.

## Acceptance scenarios (from plan §7)

Expected outcomes for each scenario are fixed in the E1.3 matrix (plan §7) before implementation.

direct without children; research for a real unknown; mandatory critique on material risk; parallel independent research; unambiguous delegation without extra allowlist; beyond-original-request → ask; explicit user prohibition/preference honored; no UI; cancelled dialog; stale/duplicate result; focus/policy change mid-flight; restart and pause; malformed consultant output; unavailable model; consultation/spend limits; oracle dedup conflict; old settings/goals untouched; project-level enable across multiple goals; project isolation; disabling from another session; existing confirmations and task-tree autonomy unchanged; no false invalidation from irrelevant task changes.

## Open items for TECH.md

Exact numeric limits (rounds, deadline, parallel consultants); `decisionMode` layer priority (project layer authoritative, no per-goal override); DecisionRecord schema and storage location; consultant model selection and fallback; accounting integration points; prompt/tool-description updates; result binding to decision/child IDs, owner/generation and context freshness (plan E5); manual-mode no-op guarantee for the oracle dedup integration; materiality classification rules; context minimization, log filtering and prompt-injection tests for read-only consultants.
