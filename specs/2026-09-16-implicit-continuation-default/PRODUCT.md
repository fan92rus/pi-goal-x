# Implicit continuation by default (#63)

> The [initial #100 proposal](../2026-10-23-open-issue-resolution/PRODUCT.md)
> added default pacing on a branch. Following user steering and comparative
> evaluation, the [continuation defaults plan](../2026-10-23-continuation-defaults-validation/PRODUCT.md)
> recommends retaining this original immediate default and making pacing opt-in.
> That production revision is pending; the branch's default backoff is provisional.

Successful executions of active auto-continuing goals continue immediately when the host is ready, without tool, task, progress, or disposition requirements. No inactivity delays or missing-disposition pauses apply by default. Final-task completion can continue into verification and audited goal completion.

One global/project setting, strictExecutionContract, defaults false. Opting in retains explicit ready/wait decisions and one repair then pause. Default mode accepts optional ready but rejects new waits without terminating. This is a user preference, not a protocol the agent should enable to continue.

Preserve explicit lifecycle actions, user cancellation, optional run/token limits, provider recovery, durable ownership and dispatch safeguards. Settings changes never renew allowance or resume paused goals. Honor existing waits and their original deadlines/check/repair bounds even after disabling strict mode; allow same-wait redeclaration, but no new waits. Resume can leave a wait.

Do not restore the pre-PR no-tool gate, introduce progress heuristics, or add pacing settings. Unproductive loops remain possible by design.
