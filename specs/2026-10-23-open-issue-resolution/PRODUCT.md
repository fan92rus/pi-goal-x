# Open issue assessment and resolution

> Final disposition, 2026-10-24: the independent #90 fix is retained. The pacing
> proposal below is historical; the approved implementation keeps immediate
> defaults and makes pacing opt-in. #100 remains open. See the
> [production result](../2026-10-23-continuation-defaults-validation/IMPLEMENTATION.md).

> Follow-up product steering, 2026-10-23: the user confirmed that the standard
> workflow is `/goal`, prompt useful continuation, and ordinary pause/resume.
> Background orchestration and extra cost controls are optional. The default
> idle-pacing decision below is provisional and must not be merged as the final
> policy. The full replacement plan and comparative validation live in
> [continuation defaults validation](../2026-10-23-continuation-defaults-validation/PRODUCT.md).
> The independent stale-context fix for #90 remains accepted.

Reviewed all open GitHub issues on 2026-10-23 against `origin/main` at
`64c5ace`. The complete open set is #90 and #100; neither has follow-up
comments. Both defects are still present and should be fixed on
`codex/fix-open-issues-90-100`.

## Project fit and decisions

The extension helps a user define and pursue durable goals automatically,
preserves human ownership of focus and lifecycle controls, and independently
audits completion. Continuation must be reliable across host lifecycle events
and economical when the executor has nothing useful to do. Keep the existing
tool surface, optional strict execution contracts, dispatch admission, budgets,
and completion safeguards.

- [#90: stale audit flush context](https://github.com/tmonk/pi-goal-x/issues/90)
  should be fixed. `GoalAuditMessages.flush()` unconditionally accesses the
  supplied context, even with an empty queue, before the settlement handler
  consumes scheduling intent. Pi invalidates context getters on replacement
  and reload. A stale settlement must be a safe no-op for the entire handler;
  it must not deliver old audit messages or consume replacement-session state.
  Keep genuine delivery/programming errors observable and preserve ordinary
  idle-only, ordered, display-only audit delivery.
- [#100: idle continuation loop](https://github.com/tmonk/pi-goal-x/issues/100)
  should be fixed with pacing, rather than requiring a progress declaration or
  pausing an otherwise active goal. The September implicit-continuation spec
  deliberately allowed unlimited unproductive executions so reasoning-only
  work would continue. The reported hours of repeated idle replies justify
  revising that narrow decision: retain automatic continuation without tools,
  but delay repeated executions without observed work. A single such execution
  continues immediately; subsequent consecutive ones wait 30, 60, 120, 240,
  then at most 300 seconds between requests. Real work or a meaningful goal/task
  change resets the streak. Usage, timestamps, revisions and scheduler writes
  are bookkeeping, not progress. Optional ready declarations alone do not reset
  the streak in default mode.

This does not adopt background-task inference or tool refusal from PR #83.
Generic `status`/`id` results do not prove a goal is blocked on detached work,
and pi-subagents' wait documentation belongs to that extension. A producer's
ordinary host message can interrupt pacing immediately; the existing explicit
wait/wake protocol remains available in strict mode. Unknown/custom tool
activity remains eligible for continuation even if it does not reset pacing.

## Required behavior

- Measure activity over the whole logical agent execution, including multiple
  tool turns, retries and compaction, rather than just its last response.
- Preserve one immediate continuation for reasoning-only work and after final
  task completion. Pacing never marks a goal paused, blocked or complete.
- Persist pacing so reload/restoration cannot silently skip a pending delay.
  Recheck its due time before spending allowance and delivering a checkpoint.
- User resume, new goals and genuine user/producer messages start promptly.
  Focus, ownership, interruption, shutdown, allowance and token-budget guards
  continue to invalidate pending dispatches. Waiting consumes no active time
  and no autonomous runs.
- Strict ready/wait decisions and provider recovery retain their own behavior.
- A stale audit callback cannot discard valid replacement-session messages.
  Session/tree transitions clear obsolete settlement intent and queued audit
  messages. Recognize the host's stale-context error narrowly.
- Document the behavior in advanced usage and the changelog. Keep the README
  layout and content unchanged.

## Validation

Add deterministic regressions for stale session getters and idle getters,
late stale callbacks after replacement, real delivery errors, idle pacing and
its cap, bookkeeping-only changes, run-wide activity, state changes, restore,
resume, takeover, claim-time checks and existing stop/limit policies. Exercise
the actual SDK with a local scripted provider to verify request counts and
context invalidation without external credentials. Run typecheck, lint, all
unit/integration/e2e suites, the test-discovery self-check and the context gate.
