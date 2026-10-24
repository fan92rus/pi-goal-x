# Runtime reliability and tolerant tool inputs

Implement the problems raised in PRs #104, #97, #92, #91 and #94 against the current codebase. Keep the standard goal workflow, pause controls and immediate continuation defaults. These are correctness and reliability fixes, not new execution modes.

User update: target Pi 1.4, with peer dependencies requiring at least 1.4 within the supported 1.x API range. Remove older-host compatibility paths and checks, including the custom-turn prompt repair, and require Node 22.19. Test native Windows behavior for this PR only; do not add Windows to ongoing CI.

- Reject stale goal checkpoints without pausing, charging or changing a replacement goal. Completion and accounting remain bound to the run that actually did the work, including native retries. When an active run creates a replacement goal, save its kickoff and start a fresh run after settlement; the old run must neither complete the new goal nor strand it. Valid saved scheduling intent can proceed after the rejected run settles.
- Preserve Pi's system prompt and tool deltas through the full-transcript hook from the first request. Preserve audit filtering, delegation and compaction behavior on Pi 1.4.
- Treat empty optional task IDs as omitted. Accept matching redundant single-task fields with an atomic batch, but reject contradictions and malformed batches without changing state. Empty batches may accompany a valid single-task call. Do not invent placeholder task IDs or weaken task/evidence rules.
- Recover from temporary Windows rename sharing failures without losing atomic replacement, revision checks, file permissions or cleanup. Bound synchronous delays tightly; ordinary writes and non-Windows failures keep their fast path. Demonstrate eventual success and permanent failure on an actual Windows runner.

Create one reviewed branch and concise PR. Credit the original contributors in GitHub and in the relevant commits for adapted tests, implementation and design contributions. Preserve contributor identity without pretending their PRs were merged unchanged. Leave README scope and unrelated user files alone.

Release update: audit the entire current project for Pi 1.4+ support, confirm the latest published Pi version, then merge #107 and release the next 0.X.0 version. Remove remaining older-host test paths and current documentation claims. Preserve historical release/specification records and compatibility with saved goal data. Keep contributor credits in merged history and release notes.
