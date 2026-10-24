# Implementation plan

> Production implementation, 2026-10-24, supersedes the provisional default
> pacing below. Preference, restoration, public prompt repair and validation
> details are in the [production result](../2026-10-23-continuation-defaults-validation/IMPLEMENTATION.md).

> The default pacing design below is provisional after the user's follow-up
> steering. Use the [continuation defaults plan](../2026-10-23-continuation-defaults-validation/TECH.md)
> for the opt-in replacement and its release gates. The #90 implementation remains
> independently accepted.

## Session-safe settlement (#90)

Make the audit flush report whether its context is usable. Read session identity
and idle state before changing the queue, catch only Pi's context-invalidation
error, and return false for stale callbacks. Keep pending replacement messages
intact. Stop `agent_settled` immediately on a stale flush, before consuming its
shared continuation/recovery flags. Clear those flags on session/tree boundaries.
Preserve exceptions unrelated to stale contexts.

## Idle continuation pacing (#100)

Add optional validated pacing metadata to scheduler version 1: a bounded idle
streak and the earliest next continuation time. Old records without it retain
their existing meaning. Keep the metadata separate from explicit `wait`, which
has user-selected semantics and finite check/deadline bounds.

Capture meaningful goal content at logical-run start, excluding usage, revision,
timestamps and scheduler state. Accumulate existing meaningful-work tool
classification across all turns of that run. Correct the event argument source
to `event.input` so its existing self-inspection/echo exclusions actually work.
At successful default settlement, reset pacing on work/content change; otherwise
advance the bounded streak and save its due time atomically with implicit ready.
Apply the same pacing to optional default-mode ready declarations. Explicit
kickoff/resume, strict contracts and recovery retain their own admission paths.

Both scheduling and claim-time admission honor the saved due time. The scheduler
uses an unref'ed timer without runtime busy polling during the delay and clears
active accounting. Resume and genuine host-message takeover clear pacing; session
restoration preserves it. Render a concise due-time line through the existing
scheduler summary, so dashboard/status/agent state explain the delay.

## Verification approach

Extend the existing session-safety and scheduler test files and real-SDK workers.
Use Node mock timers for the full pacing ladder and races; assert actual outgoing
checkpoints and persisted records rather than timer implementation details. Real
SDK tests use the initial immediate continuation, inspect persisted pacing and
verify a quiet interval; mock-time tests cover the long delays without sleeping.
Re-run the existing strict-contract/recovery tests. Re-measure context baselines
only if ordinary prompt size changes require it; verify the context gate either
way.
